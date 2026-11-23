import { expect, test } from "vitest";
import { parseTelegramRequest } from "../src/telegram.ts";

const owner = { userId: 2 ** 40, chatId: 42 };
const message = {
  message_id: 19,
  chat: { id: owner.chatId, type: "private" },
  from: { id: owner.userId, is_bot: false },
  text: "  Run the project checks.  ",
};

test("normalizes authorized text and keeps the message identity distinct from the update", () => {
  const request = parseTelegramRequest({ update_id: 7, message, extra: true }, owner);
  expect(request).toEqual({
    updateId: 7,
    messageId: 19,
    chatId: 42,
    kind: "prompt",
    text: "Run the project checks.",
  });
  expect(request?.threadId).toBeUndefined();
});

test("preserves a private topic ID for prompts and commands without broadening authorization", () => {
  const topic = { ...message, message_thread_id: 31 };
  const address = { updateId: 7, messageId: 19, chatId: 42, threadId: 31 };
  expect(parseTelegramRequest({ update_id: 7, message: topic }, owner)).toEqual({
    ...address,
    kind: "prompt",
    text: "Run the project checks.",
  });
  expect(
    parseTelegramRequest({ update_id: 7, message: { ...topic, text: "/status" } }, owner),
  ).toEqual({ ...address, kind: "status" });
  expect(
    parseTelegramRequest(
      { update_id: 7, message: { ...topic, chat: { ...message.chat, type: "supergroup" } } },
      owner,
    ),
  ).toBeNull();
  for (const message_thread_id of [null, 0, -1, 1.5, "31", 2 ** 52]) {
    expect(
      parseTelegramRequest({ update_id: 7, message: { ...topic, message_thread_id } }, owner),
    ).toBeNull();
  }
});

test("accepts only supported commands", () => {
  for (const kind of ["status", "stop"]) {
    expect(
      parseTelegramRequest({ update_id: 7, message: { ...message, text: `/${kind}` } }, owner),
    ).toEqual({ updateId: 7, messageId: 19, chatId: 42, kind });
  }
  expect(
    parseTelegramRequest({ update_id: 7, message: { ...message, text: "/start" } }, owner),
  ).toEqual({ updateId: 7, messageId: 19, chatId: 42, kind: "status" });
  expect(
    parseTelegramRequest({ update_id: 7, message: { ...message, text: "/unknown" } }, owner),
  ).toBeNull();
});

test("rejects other senders, chats, bots, and unsupported updates", () => {
  for (const input of [
    { update_id: 7, message: { ...message, from: { id: 12, is_bot: false } } },
    {
      update_id: 7,
      message: { ...message, from: { ...message.from, is_bot: true } },
    },
    {
      update_id: 7,
      message: { ...message, chat: { id: 43, type: "private" } },
    },
    { update_id: 7, message: { ...message, chat: { id: 42, type: "group" } } },
    {
      update_id: 7,
      message: {
        ...message,
        forward_origin: { type: "hidden_user" },
        text: "/stop",
      },
    },
    { update_id: 7, edited_message: message },
    { update_id: "7", message },
    { update_id: 7, message: { ...message, text: " " } },
    { update_id: 7, message: { ...message, text: `teleharness-pair-${"a".repeat(32)}` } },
    ...[undefined, 0, -1, 1.5, "19", 2 ** 52].map((message_id) => ({
      update_id: 7,
      message: { ...message, message_id },
    })),
  ]) {
    expect(parseTelegramRequest(input, owner)).toBeNull();
  }
});
