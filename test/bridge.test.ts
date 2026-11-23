import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Agent } from "../src/agent.ts";
import { createBridge } from "../src/bridge.ts";
import { lockInstance, State } from "../src/state.ts";
import { TelegramApiError } from "../src/telegram.ts";

const owner = { userId: 42, chatId: 42 };
const signal = new AbortController().signal;
let directories: string[] = [];
afterEach(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories = [];
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "teleharness-test-"));
  directories.push(directory);
  return directory;
}

function update(
  updateId: number,
  messageId: number,
  text: string,
  userId = owner.userId,
  threadId?: number,
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      message_thread_id: threadId,
      chat: { id: owner.chatId, type: "private" },
      from: { id: userId, is_bot: false },
      text,
    },
  };
}

function fixture() {
  const db = join(workspace(), "bridge.sqlite");
  const open = () => new State(db, { ...owner, botId: "123" });
  let now = 1000;
  const result = vi.fn<Agent["result"]>(async () => undefined);
  const submit = vi.fn<Agent["submit"]>(async () => "pi-submission");
  const stop = vi.fn<Agent["stop"]>(async () => {
    result.mockResolvedValue("Run stopped.");
  });
  const agent = { result, submit, stop, close: async () => {} };
  const getUpdates =
    vi.fn<
      (offset: number | undefined, signal: AbortSignal) => Promise<ReturnType<typeof update>[]>
    >();
  const sendMessage = vi.fn<(chat: number, text: string, signal: AbortSignal) => Promise<void>>();
  const bridge = (state: State) =>
    createBridge(
      state,
      owner,
      { getUpdates, sendMessage },
      async () => agent,
      () => now,
    );
  return { open, bridge, getUpdates, sendMessage, agent, advance: (ms: number) => (now += ms) };
}

test("requires recent successful Telegram polling, even when there are no updates", async () => {
  const f = fixture();
  const state = f.open();
  try {
    const bridge = f.bridge(state);
    expect(bridge.ready()).toBe(false);
    f.getUpdates.mockResolvedValueOnce([]);
    await bridge.poll(signal);
    expect(bridge.ready()).toBe(true);
    f.advance(70_000);
    expect(bridge.ready()).toBe(false);
    f.getUpdates.mockRejectedValueOnce(new TelegramApiError("Telegram unavailable", true));
    await expect(bridge.poll(signal)).rejects.toThrow();
    expect(bridge.ready()).toBe(false);
  } finally {
    state.close();
  }
});

test("poll records authorized input before confirming it, then deduplicates redelivery after reopen", async () => {
  const f = fixture();
  f.getUpdates.mockResolvedValueOnce([
    update(98, 10, "Check the project"),
    update(99, 11, "/stop", 7),
  ]);
  f.getUpdates.mockResolvedValueOnce([]);
  let state = f.open();
  try {
    await f.bridge(state).poll(signal);
  } finally {
    state.close();
  }
  state = f.open();
  try {
    expect(state.pending()?.id).toBe(10);
    f.getUpdates.mockReset();
    f.getUpdates
      .mockResolvedValueOnce([update(98, 10, "Check the project"), update(99, 11, "/stop", 7)])
      .mockResolvedValueOnce([]);
    const worker = f.bridge(state);
    await worker.poll(signal);
    await worker.poll(signal);
    expect(f.getUpdates.mock.calls.map(([offset]) => offset)).toEqual([undefined, 100]);
    await worker.work();
    f.agent.result.mockResolvedValue("Looks good.");
    await worker.work();
    await worker.deliver(signal);
    expect(f.agent.submit.mock.calls).toEqual([["telegram-message:10", "Check the project"]]);
    expect(f.sendMessage.mock.calls).toEqual([[42, "#10 Looks good.", signal]]);
    expect(f.agent.stop).not.toHaveBeenCalled();
  } finally {
    state.close();
  }
});

test("retries the same Pi request ID if admission committed but its receipt did not", async () => {
  const f = fixture();
  let state = f.open();
  try {
    f.getUpdates.mockResolvedValue([update(100, 12, "Resume me")]);
    const worker = f.bridge(state);
    await worker.poll(signal);
    await worker.work();
    f.agent.submit.mockRejectedValueOnce(new Error("interrupted before receipt was recorded"));
    await expect(worker.work()).rejects.toThrow();
  } finally {
    state.close();
  }
  state = f.open();
  try {
    const worker = f.bridge(state);
    f.agent.result.mockResolvedValue("Recovered.");
    await worker.work();
    await worker.deliver(signal);
    expect(f.agent.submit.mock.calls).toEqual([
      ["telegram-message:12", "Resume me"],
      ["telegram-message:12", "Resume me"],
    ]);
    expect(f.sendMessage).toHaveBeenCalledWith(42, "#12 Recovered.", signal);
  } finally {
    state.close();
  }
});

test("status and stop can run while the model is pending; a second prompt is rejected as busy", async () => {
  const f = fixture();
  const state = f.open();
  try {
    f.getUpdates.mockResolvedValue([
      update(101, 20, "A slow task"),
      update(102, 21, "A second task"),
      update(103, 22, "/status"),
      update(104, 23, "/stop"),
    ]);
    const worker = f.bridge(state);
    await worker.poll(signal);
    for (let i = 0; i < 5; i++) await worker.work();
    for (let i = 0; i < 4; i++) {
      await worker.deliver(signal);
      f.advance(1000);
    }
    expect(f.agent.stop).toHaveBeenCalledTimes(1);
    expect(f.agent.submit).toHaveBeenCalledTimes(1);
    expect(f.sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      "#20 Run stopped.",
      "#21 Busy with run #20. Try again when it finishes.",
      "#22 Run #20 is active.",
      "#23 Stop requested for run #20.",
    ]);
  } finally {
    state.close();
  }
});

test("outbox survives reopen, honors Telegram backoff, and caps failed sends", async () => {
  const f = fixture();
  let state = f.open();
  try {
    const api = f.bridge(state);
    f.getUpdates.mockResolvedValueOnce([update(105, 30, "/status")]);
    await api.poll(signal);
    await api.work();
    f.sendMessage.mockRejectedValue(new TelegramApiError("Telegram unavailable", true, 8000));
    await api.deliver(signal);
  } finally {
    state.close();
  }
  state = f.open();
  try {
    const worker = f.bridge(state);
    f.advance(7999);
    await worker.deliver(signal);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      f.advance(8000);
      await worker.deliver(signal);
    }
    expect(f.sendMessage).toHaveBeenCalledTimes(4);
    expect(state.failedCount(0)).toBe(1);
  } finally {
    state.close();
  }
});

test("a chat flood wait survives reopen and also blocks replies to other topics", async () => {
  const f = fixture();
  let state = f.open();
  try {
    const worker = f.bridge(state);
    f.getUpdates.mockResolvedValueOnce([
      update(105, 30, "/status", owner.userId, 91),
      update(106, 31, "/status", owner.userId, 92),
    ]);
    await worker.poll(signal);
    await worker.work();
    await worker.work();
    f.sendMessage.mockRejectedValueOnce(new TelegramApiError("Telegram flood wait", true, 8000));
    await worker.deliver(signal);
  } finally {
    state.close();
  }
  state = f.open();
  try {
    const worker = f.bridge(state);
    f.advance(7999);
    await worker.deliver(signal);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    f.advance(1);
    await worker.deliver(signal);
    f.advance(1000);
    await worker.deliver(signal);
    expect(f.sendMessage).toHaveBeenCalledTimes(3);
    expect(f.sendMessage).toHaveBeenLastCalledWith(42, "#31 Idle.", signal, 92);
  } finally {
    state.close();
  }
});

test("state directories are locked and bound to the original chat identity", () => {
  const directory = workspace();
  const lock = join(directory, "instance.sqlite");
  const unlock = lockInstance(lock);
  try {
    expect(() => lockInstance(lock)).toThrow(/one instance/);
  } finally {
    unlock();
  }
  lockInstance(lock)();
  const bridge = join(directory, "bridge.sqlite");
  new State(bridge, { ...owner, botId: "123" }).close();
  expect(() => new State(bridge, { ...owner, botId: "456" })).toThrow(/different bot or owner/);
});

test("limits concurrent topics and stops only the topic that requested it", async () => {
  const f = fixture();
  const state = f.open();
  const handles = new Map<number, Agent["stop"]>();
  const api = { getUpdates: f.getUpdates, sendMessage: f.sendMessage };
  let now = 1000;
  const worker = createBridge(
    state,
    owner,
    api,
    async (thread) => {
      const stop = vi.fn(async () => {});
      const agent = {
        submit: async () => `pi-${thread}`,
        result: async () => undefined,
        stop,
        close: async () => {},
      };
      handles.set(thread, stop);
      return agent;
    },
    () => now,
  );
  try {
    f.getUpdates.mockResolvedValue([
      update(110, 40, "First", owner.userId, 70),
      update(111, 41, "Second", owner.userId, 71),
      update(112, 42, "Third", owner.userId, 72),
      update(113, 43, "Fourth", owner.userId, 73),
      update(114, 44, "/stop", owner.userId, 71),
    ]);
    await worker.poll(signal);
    for (let i = 0; i < 5; i++) await worker.work();
    expect([...handles.keys()]).toEqual([70, 71, 72]);
    expect(handles.get(70)).not.toHaveBeenCalled();
    expect(handles.get(71)).toHaveBeenCalledTimes(1);
    expect(handles.get(72)).not.toHaveBeenCalled();
    await worker.deliver(signal);
    now += 1000;
    await worker.deliver(signal);
    expect(f.sendMessage.mock.calls).toEqual([
      [42, "#43 All 3 session slots are busy. Try again later.", signal, 73],
      [42, "#44 Stop requested for run #41.", signal, 71],
    ]);
  } finally {
    await worker.close();
    state.close();
  }
});
