import { expect, test, vi } from "vitest";
import { createTelegramApi, parseTelegramRequest, TelegramApiError } from "../src/telegram.ts";

const token = "123:token-secret";
const signal = new AbortController().signal;
const apiUrl = `https://api.telegram.org/bot${token}`;

test("polls the fixed API host with a bounded long poll and preserves update payloads", async () => {
  const payload = [
    {
      update_id: 123,
      message: {
        message_id: 17,
        message_thread_id: 31,
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: "private" },
        text: "do work",
      },
      future_field: { keep: true },
    },
    { update_id: 124, edited_message: { text: "ignore me" } },
  ];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: payload }));
  const api = createTelegramApi(token, fetcher);

  const updates = await api.getUpdates(undefined, signal);
  expect(updates).toEqual(payload);
  expect(parseTelegramRequest(updates[0], { userId: 42, chatId: 42 })).toEqual({
    updateId: 123,
    messageId: 17,
    chatId: 42,
    threadId: 31,
    kind: "prompt",
    text: "do work",
  });
  await api.getUpdates(125, signal);

  const [[url, first], [, second]] = fetcher.mock.calls;
  expect(url).toBe(`${apiUrl}/getUpdates`);
  expect(first).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: expect.any(AbortSignal),
  });
  const base = { timeout: 25, limit: 100, allowed_updates: ["message"] };
  expect(JSON.parse(String(first?.body))).toEqual(base);
  expect(JSON.parse(String(second?.body))).toEqual({ ...base, offset: 125 });
});

test("sends plain text without formatting or following redirects", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, result: { message_id: 4 } }),
  );
  const text = "*plain* <text> `code`";
  await expect(createTelegramApi(token, fetcher).sendMessage(42, text, signal)).resolves.toBe(
    undefined,
  );
  const [[url, options]] = fetcher.mock.calls;
  expect(url).toBe(`${apiUrl}/sendMessage`);
  expect(options).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(String(options?.body))).toEqual({ chat_id: 42, text });
});

test("targets a private-chat topic only when a valid thread ID is supplied", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, result: { message_id: 4 } }),
  );
  const api = createTelegramApi(token, fetcher);
  await api.sendMessage(42, "topic reply", signal, 31);
  const [[url, options]] = fetcher.mock.calls;
  expect(url).toBe(`${apiUrl}/sendMessage`);
  expect(JSON.parse(String(options?.body))).toEqual({
    chat_id: 42,
    text: "topic reply",
    message_thread_id: 31,
  });
  await expect(api.sendMessage(42, "invalid topic", signal, NaN)).rejects.toMatchObject({
    message: "Invalid Telegram thread ID.",
    retryable: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("rejects malformed responses instead of returning partial updates or acknowledging sends", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("not JSON"))
    .mockResolvedValueOnce(Response.json({ ok: "true", result: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
    .mockResolvedValueOnce(
      Response.json({ ok: true, result: [{ update_id: 7 }, { update_id: 0 }] }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true, result: [{ update_id: "7" }] }))
    .mockResolvedValueOnce(Response.json({ ok: true, result: true }));
  const api = createTelegramApi(token, fetcher);
  const invalid = {
    message: "Invalid Telegram API response.",
    retryable: false,
    retryAfterMs: 0,
  };
  for (let i = 0; i < 6; i += 1) {
    await expect(api.getUpdates(undefined, signal)).rejects.toMatchObject(invalid);
  }
  await expect(api.sendMessage(42, "send", signal)).rejects.toMatchObject(invalid);
});

test("classifies HTTP and API failures without exposing Telegram responses or network errors", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error(`Failed to fetch ${apiUrl}/getUpdates`))
    .mockResolvedValueOnce(new Response("proxy body secret", { status: 502 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "Telegram body secret",
          parameters: { retry_after: 3 },
        },
        { status: 429, headers: { "Retry-After": "2" } },
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "4" } }))
    .mockResolvedValueOnce(Response.json({ ok: false, error_code: 500 }))
    .mockResolvedValueOnce(new Response("invalid bot", { status: 401 }))
    .mockResolvedValueOnce(Response.json({ ok: true, result: [] }, { status: 403 }));
  const api = createTelegramApi(token, fetcher);
  for (const [retryable, retryAfterMs] of [
    [true, 0],
    [true, 0],
    [true, 3000],
    [true, 4000],
    [true, 0],
    [false, 0],
    [false, 0],
  ]) {
    const error = await api.getUpdates(undefined, signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ retryable, retryAfterMs });
    expect((error as Error).stack).not.toMatch(/secret|invalid bot|api\.telegram\.org/);
    expect((error as Error).cause).toBeUndefined();
  }
});

test("caller cancellation aborts the transport and never exposes the caller's reason", async () => {
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const caller = new AbortController();
  const api = createTelegramApi(token, fetcher);
  const updating = api.getUpdates(undefined, caller.signal);
  const rejected = expect(updating).rejects.toMatchObject({
    message: "Telegram request aborted.",
    retryable: false,
    retryAfterMs: 0,
  });
  caller.abort("caller secret");
  await rejected;
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await expect(api.sendMessage(42, "send", caller.signal)).rejects.toThrow(
    "Telegram request aborted.",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("deadlines bound long polls and response body reads even when the fetcher ignores abort", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(new Response(new ReadableStream()));
    const api = createTelegramApi(token, fetcher);
    const timedOut = {
      message: "Telegram request timed out.",
      retryable: true,
      retryAfterMs: 0,
    };
    const poll = expect(api.getUpdates(undefined, signal)).rejects.toMatchObject(timedOut);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await poll;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);

    const send = expect(api.sendMessage(42, "send", signal)).rejects.toMatchObject(timedOut);
    await vi.advanceTimersByTimeAsync(10_000);
    await send;
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
