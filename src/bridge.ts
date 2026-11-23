import type { Agent } from "./agent.ts";
import type { State } from "./state.ts";
import {
  parseTelegramRequest,
  TelegramApiError,
  type Owner,
  type TelegramApi,
} from "./telegram.ts";

const dayMs = 86_400_000;
const maxActiveSessions = 3;

export function createBridge(
  state: State,
  owner: Owner,
  api: TelegramApi,
  openAgent: (thread: number) => Promise<Agent>,
  now = Date.now,
) {
  const agents = new Map<number, Agent>();
  let offset: number | undefined;
  let lastBatchAt = 0;

  return {
    async poll(signal: AbortSignal) {
      // Offset is not durable. On reopen Telegram can redeliver, and the inbox deduplicates.
      // Drop it well before Telegram can choose a random update ID after a week of inactivity.
      if (now() - lastBatchAt >= dayMs) offset = undefined;
      const updates = await api.getUpdates(offset, signal);
      if (!updates.length) return;
      const requests = updates.flatMap((update) => {
        const request = parseTelegramRequest(update, owner);
        return request === null ? [] : [request];
      });
      state.receive(requests);
      offset = Math.max(...updates.map((update) => update.update_id)) + 1;
      lastBatchAt = now();
    },

    async work() {
      const activeByThread = new Map<number, number>();
      for (const active of state.active()) {
        let agent = agents.get(active.thread);
        if (!agent) {
          agent = await openAgent(active.thread);
          agents.set(active.thread, agent);
        }
        let submission = active.submission;
        if (!submission) {
          if (active.text === null) throw new Error("Active prompt has no stored text.");
          submission = await agent.submit(`telegram-message:${active.id}`, active.text);
          state.submitted(active.id, submission);
        }
        const result = await agent.result(submission);
        if (result !== undefined) {
          state.reply(active.id, result);
          agents.delete(active.thread);
          await agent.close();
        } else {
          activeByThread.set(active.thread, active.id);
        }
      }

      const request = state.pending();
      if (!request) return;
      const active = activeByThread.get(request.thread);
      if (request.kind === "status") {
        const headline = active ? `Run #${active} is active.` : "Idle.";
        const failed = state.failedCount(request.thread);
        state.reply(request.id, failed ? `${headline} Undelivered replies: ${failed}.` : headline);
      } else if (request.kind === "stop") {
        const agent = agents.get(request.thread);
        if (active && agent) {
          await agent.stop();
          state.reply(request.id, `Stop requested for run #${active}.`);
        } else {
          state.reply(request.id, "No active run to stop.");
        }
      } else if (active) {
        state.reply(request.id, `Busy with run #${active}. Try again when it finishes.`);
      } else if (activeByThread.size >= maxActiveSessions) {
        state.reply(
          request.id,
          `All ${maxActiveSessions} session slots are busy. Try again later.`,
        );
      } else {
        // Commit the claim before calling Pi. A restarted worker can retry with the same request ID.
        state.activate(request.id);
      }
    },

    async deliver(signal: AbortSignal) {
      const reply = state.nextReply(now());
      if (!reply) return;
      state.reserveAttempt(reply.id, now());
      try {
        if (reply.thread) {
          await api.sendMessage(owner.chatId, reply.reply, signal, reply.thread);
        } else {
          await api.sendMessage(owner.chatId, reply.reply, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof TelegramApiError)) throw error;
        if (!error.retryable) {
          state.deliveryFailed(reply.id, null);
          return;
        }
        const retryAt = now() + Math.max(error.retryAfterMs, 1000 * 2 ** reply.attempts);
        state.deliveryFailed(reply.id, retryAt);
        return;
      }
      state.delivered(reply.id);
    },

    async close() {
      const settled = await Promise.allSettled([...agents.values()].map((agent) => agent.close()));
      agents.clear();
      if (settled.some((result) => result.status === "rejected")) {
        throw new Error("Could not close agent sessions.");
      }
    },
  };
}
