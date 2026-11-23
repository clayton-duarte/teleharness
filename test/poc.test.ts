import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { expect, test, vi } from "vitest";
import { openAgent } from "../src/agent.ts";
import { createBridge } from "../src/bridge.ts";
import { State } from "../src/state.ts";
import { createTelegramApi } from "../src/telegram.ts";

const owner = { userId: 42, chatId: 42 };

function update(messageId: number, thread: number, text: string) {
  return {
    update_id: 100 + messageId,
    message: {
      message_id: messageId,
      message_thread_id: thread,
      chat: { id: owner.chatId, type: "private" },
      from: { id: owner.userId, is_bot: false },
      text,
    },
  };
}

test("private Telegram topics keep separate Pi histories across bridge reopen", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { provider, id: modelId } = faux.getModel();
  const histories = new Map<string, string[]>();
  const respond: FauxResponseFactory = ({ messages }) => {
    const history = messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("");
      return `${message.role}: ${text}`;
    });
    const prompt = history.at(-1) ?? "";
    histories.set(prompt, history);
    return fauxAssistantMessage(`Reply to ${prompt.slice("user: ".length)}`);
  };
  faux.setResponses([respond, respond, respond, respond]);

  const updates: ReturnType<typeof update>[] = [];
  const replies: unknown[] = [];
  const fakeFetch: typeof fetch = async (url, options) => {
    switch (String(url)) {
      case "https://api.telegram.org/bot123:fake/getUpdates":
        return Response.json({ ok: true, result: updates.splice(0) });
      case "https://api.telegram.org/bot123:fake/sendMessage":
        replies.push(JSON.parse(String(options?.body)));
        return Response.json({ ok: true, result: { message_id: 1000 + replies.length } });
      default:
        throw new Error(`Unexpected Telegram request: ${url}`);
    }
  };
  const api = createTelegramApi("123:fake", fakeFetch);
  const signal = new AbortController().signal;
  let now = 1000;
  const directory = await mkdtemp(join(tmpdir(), "teleharness-poc-"));

  async function runBatch(...batch: ReturnType<typeof update>[]) {
    updates.push(...batch);
    const expectedReplies = replies.length + batch.length;
    const state = new State(join(directory, "bridge.sqlite"), { ...owner, botId: "123" });
    try {
      const bridge = createBridge(
        state,
        owner,
        api,
        (thread) =>
          openAgent(join(directory, `session-${thread}.sqlite`), models, { provider, modelId }),
        () => now,
      );
      try {
        await bridge.poll(signal);
        await vi.waitFor(
          async () => {
            await bridge.work();
            await bridge.deliver(signal);
            now += 1000;
            expect(replies).toHaveLength(expectedReplies);
          },
          { interval: 10, timeout: 2000 },
        );
      } finally {
        await bridge.close();
      }
    } finally {
      state.close();
    }
  }

  try {
    await runBatch(update(10, 101, "Alpha"), update(11, 202, "Beta"));
    await runBatch(update(12, 101, "More alpha"), update(13, 202, "More beta"));

    expect(faux.state.callCount).toBe(4);
    expect(histories.get("user: Alpha")).toEqual(["user: Alpha"]);
    expect(histories.get("user: Beta")).toEqual(["user: Beta"]);
    expect(histories.get("user: More alpha")).toEqual([
      "user: Alpha",
      "assistant: Reply to Alpha",
      "user: More alpha",
    ]);
    expect(histories.get("user: More beta")).toEqual([
      "user: Beta",
      "assistant: Reply to Beta",
      "user: More beta",
    ]);
    expect(replies).toEqual(
      expect.arrayContaining([
        { chat_id: 42, message_thread_id: 101, text: "#10 Reply to Alpha" },
        { chat_id: 42, message_thread_id: 202, text: "#11 Reply to Beta" },
        { chat_id: 42, message_thread_id: 101, text: "#12 Reply to More alpha" },
        { chat_id: 42, message_thread_id: 202, text: "#13 Reply to More beta" },
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
