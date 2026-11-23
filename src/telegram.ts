import { z } from "zod";

const id = z
  .number()
  .int()
  .positive()
  .max(2 ** 52 - 1);
const threadIdSchema = id.optional();
const update = z.object({
  update_id: id,
  message: z.object({
    message_id: id,
    message_thread_id: threadIdSchema,
    forward_origin: z.never().optional(),
    chat: z.object({ id, type: z.literal("private") }),
    from: z.object({ id, is_bot: z.literal(false) }),
    text: z.string().trim().min(1).max(4096),
  }),
});

export type Owner = Readonly<{ userId: number; chatId: number }>;
export type TelegramRequest = {
  updateId: number;
  messageId: number;
  chatId: number;
  threadId?: number;
} & ({ kind: "prompt"; text: string } | { kind: "status" | "stop" });

export function parseTelegramRequest(input: unknown, owner: Owner): TelegramRequest | null {
  const parsed = update.safeParse(input);
  if (!parsed.success) return null;

  const { update_id, message } = parsed.data;
  if (message.chat.id !== owner.chatId || message.from.id !== owner.userId) return null;

  const threadId = message.message_thread_id;
  const address = {
    updateId: update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    ...(threadId === undefined ? {} : { threadId }),
  };
  if (message.text === "/start" || message.text === "/status")
    return { ...address, kind: "status" };
  if (message.text === "/stop") return { ...address, kind: "stop" };
  if (/^teleharness-pair-[0-9a-f]{32}$/.test(message.text)) return null;
  if (message.text.startsWith("/")) return null;
  return { ...address, kind: "prompt", text: message.text };
}

export interface TelegramApi {
  getUpdates(offset: number | undefined, signal: AbortSignal): Promise<{ update_id: number }[]>;
  sendMessage(chatId: number, text: string, signal: AbortSignal, threadId?: number): Promise<void>;
}

export class TelegramApiError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number;

  constructor(message: string, retryable: boolean, retryAfterMs = 0) {
    super(message);
    this.name = "TelegramApiError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const pollSeconds = 25;
const requestTimeoutMs = 10_000;
const updateLimit = 100;
const maxRetrySeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const updatesResult = z.array(z.looseObject({ update_id: id })).max(updateLimit);
const messageResult = z.object({ message_id: id });
const successResponse = z.object({ ok: z.literal(true), result: z.unknown() });
const errorResponse = z.object({
  ok: z.literal(false),
  error_code: z.number().int().positive(),
  parameters: z
    .object({ retry_after: z.number().int().nonnegative().max(maxRetrySeconds).optional() })
    .optional(),
});

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterHeader(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds <= maxRetrySeconds ? seconds * 1000 : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function createTelegramApi(token: string, fetcher: typeof fetch = fetch): TelegramApi {
  let baseUrl: string;
  try {
    const segment = encodeURIComponent(token).replaceAll("%3A", ":");
    baseUrl = `https://api.telegram.org/bot${segment}`;
  } catch {
    throw new TelegramApiError("Invalid Telegram bot token.", false);
  }

  async function request(
    method: "getUpdates" | "sendMessage",
    body: Record<string, unknown>,
    callerSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    if (callerSignal.aborted) throw new TelegramApiError("Telegram request aborted.", false);

    const deadline = new AbortController();
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const abortError = () =>
      callerSignal.aborted
        ? new TelegramApiError("Telegram request aborted.", false)
        : new TelegramApiError("Telegram request timed out.", true);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });

    const fetchResult = async () => {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch {
        throw signal.aborted
          ? abortError()
          : new TelegramApiError("Telegram network request failed.", true);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (signal.aborted) throw abortError();
      }

      const error = errorResponse.safeParse(payload);
      if (!response.ok || error.success) {
        const apiCode = error.success ? error.data.error_code : 0;
        const apiRetryAfterMs = error.success
          ? (error.data.parameters?.retry_after ?? 0) * 1000
          : 0;
        throw new TelegramApiError(
          "Telegram API rejected the request.",
          isRetryableStatus(response.ok ? apiCode : response.status),
          Math.max(apiRetryAfterMs, retryAfterHeader(response.headers.get("Retry-After"))),
        );
      }

      const success = successResponse.safeParse(payload);
      if (!success.success) throw invalidResponse();
      return success.data.result;
    };

    try {
      return await Promise.race([aborted, fetchResult()]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    async getUpdates(offset, signal) {
      const result = updatesResult.safeParse(
        await request(
          "getUpdates",
          { offset, timeout: pollSeconds, limit: updateLimit, allowed_updates: ["message"] },
          signal,
          pollSeconds * 1000 + requestTimeoutMs,
        ),
      );
      if (!result.success) throw invalidResponse();
      return result.data;
    },
    async sendMessage(chatId, text, signal, threadId) {
      if (!threadIdSchema.safeParse(threadId).success) {
        throw new TelegramApiError("Invalid Telegram thread ID.", false);
      }
      const result = messageResult.safeParse(
        await request(
          "sendMessage",
          { chat_id: chatId, text, message_thread_id: threadId },
          signal,
          requestTimeoutMs,
        ),
      );
      if (!result.success) throw invalidResponse();
    },
  };
}

function invalidResponse(): TelegramApiError {
  return new TelegramApiError("Invalid Telegram API response.", false);
}
