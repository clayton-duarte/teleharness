import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const bot = z.object({ is_bot: z.literal(true), username: z.string().regex(/^[A-Za-z0-9_]+$/) });
const webhook = z.object({ url: z.string() });
const id = z
  .int()
  .min(1)
  .max(2 ** 52 - 1);
const update = z.object({
  message: z.object({
    from: z.object({ id, is_bot: z.literal(false) }),
    chat: z.object({ id, type: z.literal("private") }),
    forward_origin: z.never().optional(),
    text: z.string(),
  }),
});
const envelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error_code: z.number() }),
]);

export async function pairTelegram(
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  if (!token || !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/.test(token)) {
    output.error("Missing or invalid TELEGRAM_BOT_TOKEN.");
    return 1;
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 90_000);
  const conflict = Symbol("Telegram polling conflict");
  let method: "getMe" | "getWebhookInfo" | "getUpdates" = "getMe";
  let fullBatch = false;

  async function request(body: object, signal: AbortSignal): Promise<unknown> {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    if (response.status === 409) throw conflict;
    if (!response.ok) throw new Error();
    const payload = envelope.parse(await response.json());
    if (!payload.ok) {
      if (payload.error_code === 409) throw conflict;
      throw new Error();
    }
    return payload.result;
  }

  try {
    const setupSignal = () => AbortSignal.any([deadline.signal, AbortSignal.timeout(10_000)]);
    const { username } = bot.parse(await request({}, setupSignal()));
    output.log(`Telegram bot: @${username}`);

    method = "getWebhookInfo";
    if (webhook.parse(await request({}, setupSignal())).url !== "") {
      output.error("This bot has a webhook configured. Pairing stopped without changing it.");
      return 1;
    }

    const challenge = `teleharness-pair-${randomBytes(16).toString("hex")}`;
    output.log(`Send this exact text to @${username} in a private chat:`);
    output.log(challenge);

    method = "getUpdates";
    while (true) {
      // An offset would confirm older updates; allowed_updates would change the bot's filter.
      const batch = z.array(z.unknown()).parse(await request({ timeout: 20 }, deadline.signal));
      for (const raw of batch) {
        const parsed = update.safeParse(raw);
        if (!parsed.success || parsed.data.message.text !== challenge) continue;
        const { from, chat } = parsed.data.message;
        output.log(`TELEGRAM_USER_ID=${from.id}`);
        output.log(`TELEGRAM_CHAT_ID=${chat.id}`);
        return 0;
      }
      fullBatch = batch.length >= 100;
      await delay(1_000, undefined, { signal: deadline.signal });
    }
  } catch (error) {
    if (method === "getUpdates" && error === conflict) {
      output.error(
        "Telegram polling conflict. Stop any other poller for this bot, check that no webhook is configured, and retry.",
      );
    } else if (method === "getUpdates" && deadline.signal.aborted) {
      output.error(
        fullBatch
          ? "Pairing timed out. A full queue of older updates may be hiding the challenge; pairing did not acknowledge any updates."
          : "Pairing timed out. Verify the bot username and send the exact new challenge in a private chat after retrying.",
      );
    } else {
      output.error(`Telegram ${method} failed. Check the bot token and network, then retry.`);
    }
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
