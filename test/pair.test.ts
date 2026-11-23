import { expect, test, vi } from "vitest";
import { pairTelegram } from "../src/pairing.ts";

const token = "123:token-secret";
const apiUrl = `https://api.telegram.org/bot${token}`;
const ok = (result: unknown) => Response.json({ ok: true, result });
const bot = { is_bot: true, username: "ExampleBot" };
const output = () => ({
  log: vi.fn<(text: string) => void>(),
  error: vi.fn<(text: string) => void>(),
});

test("prints only the matching sender and chat IDs without acknowledging updates", async () => {
  const terminal = output();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(bot))
    .mockResolvedValueOnce(ok({ url: "" }))
    .mockImplementationOnce(async () => {
      const challenge = terminal.log.mock.calls.at(-1)![0];
      expect(challenge).toMatch(/^teleharness-pair-[a-f0-9]{32}$/);
      return ok([
        {
          message: {
            text: challenge,
            chat: { id: 17, type: "group" },
            from: { id: 19, is_bot: false },
          },
        },
        {
          message: {
            text: challenge,
            chat: { id: 17, type: "private" },
            from: { id: 19, is_bot: true },
          },
        },
        {
          message: {
            text: `${challenge} `,
            chat: { id: 17, type: "private" },
            from: { id: 19, is_bot: false },
          },
        },
        {
          message: {
            text: challenge,
            chat: { id: 17, type: "private" },
            from: { id: 19, is_bot: false },
            forward_origin: {},
          },
        },
      ]);
    })
    .mockImplementationOnce(async () => {
      const challenge = terminal.log.mock.calls.at(-1)![0];
      return ok([
        {
          message: {
            text: challenge,
            chat: { id: 42, type: "private" },
            from: { id: 73, is_bot: false, first_name: "not printed" },
          },
        },
      ]);
    });

  await expect(pairTelegram(token, fetcher, terminal)).resolves.toBe(0);
  expect(terminal.log.mock.calls.map(([text]) => text)).toEqual([
    "Telegram bot: @ExampleBot",
    "Send this exact text to @ExampleBot in a private chat:",
    expect.stringMatching(/^teleharness-pair-[a-f0-9]{32}$/),
    "TELEGRAM_USER_ID=73",
    "TELEGRAM_CHAT_ID=42",
  ]);
  expect(terminal.error).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
    ["getMe", "getWebhookInfo", "getUpdates", "getUpdates"].map((method) => `${apiUrl}/${method}`),
  );
  for (const [, options] of fetcher.mock.calls.slice(2)) {
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(options?.body))).toEqual({ timeout: 20 });
  }
});

test("reports a webhook without printing its URL or polling", async () => {
  const terminal = output();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(bot))
    .mockResolvedValueOnce(ok({ url: "https://secret.example/webhook" }));
  await expect(pairTelegram(token, fetcher, terminal)).resolves.toBe(1);
  expect(terminal.log.mock.calls).toEqual([["Telegram bot: @ExampleBot"]]);
  expect(terminal.error).toHaveBeenCalledWith(
    "This bot has a webhook configured. Pairing stopped without changing it.",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("reports another poller without printing Telegram's conflict response", async () => {
  const terminal = output();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(bot))
    .mockResolvedValueOnce(ok({ url: "" }))
    .mockResolvedValueOnce(
      Response.json({ ok: false, error_code: 409, description: apiUrl }, { status: 409 }),
    );
  await expect(pairTelegram(token, fetcher, terminal)).resolves.toBe(1);
  expect(terminal.error.mock.calls).toEqual([[expect.stringContaining("Stop any other poller")]]);
  expect(terminal.error.mock.calls[0][0]).not.toContain(token);
});

test("handles missing tokens and redacts transport failures", async () => {
  const terminal = output();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(apiUrl));
  await expect(pairTelegram(undefined, fetcher, terminal)).resolves.toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(pairTelegram(token, fetcher, terminal)).resolves.toBe(1);
  expect(terminal.error.mock.calls).toEqual([
    ["Missing or invalid TELEGRAM_BOT_TOKEN."],
    ["Telegram getMe failed. Check the bot token and network, then retry."],
  ]);
});

test("times out after at most 90 seconds and explains a full backlog", async () => {
  vi.useFakeTimers();
  try {
    const terminal = output();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(bot))
      .mockResolvedValueOnce(ok({ url: "" }))
      .mockResolvedValue(ok(Array.from({ length: 100 }, () => ({}))));
    const pairing = pairTelegram(token, fetcher, terminal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(terminal.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pairing).resolves.toBe(1);
    expect(terminal.error.mock.calls).toEqual([[expect.stringContaining("full queue")]]);
  } finally {
    vi.useRealTimers();
  }
});
