import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createAgentOpener } from "./agent.ts";
import { createApp } from "./app.ts";
import { createBridge } from "./bridge.ts";
import { ConfigError, parseConfig } from "./config.ts";
import { lockInstance, State } from "./state.ts";
import { createTelegramApi, TelegramApiError } from "./telegram.ts";

async function serveBridge(bridge: ReturnType<typeof createBridge>, port: number) {
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => controller.abort();
  const server = serve({ fetch: createApp().fetch, hostname: "127.0.0.1", port });
  server.once("error", () => {
    console.error("Could not start the local health server.");
    process.exitCode = 1;
    stop();
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const loop = async (step: () => Promise<void>, interval: number) => {
    try {
      while (!signal.aborted) {
        await step();
        if (interval > 0) await delay(interval, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) {
        stop();
        throw error;
      }
    }
  };
  try {
    const settled = await Promise.allSettled([
      loop(async () => {
        try {
          await bridge.poll(signal);
        } catch (error) {
          if (!(error instanceof TelegramApiError) || !error.retryable) throw error;
          let remaining = Math.max(1000, error.retryAfterMs);
          while (remaining > 0) {
            const chunk = Math.min(remaining, 2_147_483_647);
            await delay(chunk, undefined, { signal });
            remaining -= chunk;
          }
        }
      }, 0),
      loop(bridge.work, 250),
      loop(() => bridge.deliver(signal), 250),
    ]);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    server.close();
  }
}

async function run(config: ReturnType<typeof parseConfig>) {
  const open = createAgentOpener(config.model);
  const api = createTelegramApi(config.token);
  await mkdir(config.directory, { mode: 0o700, recursive: true });
  const info = await lstat(config.directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error("State directory must be a private directory (mode 0700).");
  }
  const releaseLock = lockInstance(join(config.directory, "instance.sqlite"));
  try {
    const state = new State(join(config.directory, "bridge.sqlite"), {
      ...config.owner,
      botId: config.botId,
    });
    try {
      const bridge = createBridge(state, config.owner, api, (thread) =>
        open(join(config.directory, `session-${thread}.sqlite`)),
      );
      try {
        await serveBridge(bridge, config.port);
      } finally {
        await bridge.close();
      }
    } finally {
      state.close();
    }
  } finally {
    releaseLock();
  }
}

let config: ReturnType<typeof parseConfig> | undefined;
try {
  config = parseConfig(process.env);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "Invalid configuration.");
  process.exitCode = 1;
}
if (config) {
  try {
    await run(config);
  } catch (error) {
    // Never print provider exceptions, URLs, tokens, or raw update bodies.
    console.error(
      error instanceof TelegramApiError
        ? error.message
        : "Teleharness failed. Check the model configuration and that the state directory is private, writable, and not already in use.",
    );
    process.exitCode = 1;
  }
}
