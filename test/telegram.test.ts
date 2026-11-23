import { expect, test } from "vitest";
import { parseTelegramRequest } from "../src/telegram.ts";

const owner = { userId: 2 ** 40, chatId: 42 };
const message = {
  chat: { id: owner.chatId, type: "private" },
  from: { id: owner.userId, is_bot: false },
  text: "  Run the project checks.  ",
};

test("normalizes authorized text and preserves the update identity", () => {
  expect(parseTelegramRequest({ update_id: 7, message, extra: true }, owner)).toEqual({
    updateId: 7,
    chatId: 42,
    kind: "prompt",
    text: "Run the project checks.",
  });
});

test("accepts only supported commands", () => {
  for (const kind of ["status", "stop"]) {
    expect(
      parseTelegramRequest({ update_id: 7, message: { ...message, text: `/${kind}` } }, owner),
    ).toEqual({ updateId: 7, chatId: 42, kind });
  }
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
  ]) {
    expect(parseTelegramRequest(input, owner)).toBeNull();
  }
});
