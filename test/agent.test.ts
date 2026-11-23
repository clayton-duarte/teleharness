import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, test } from "vitest";
import { type Agent, openAgent } from "../src/agent.ts";

let directory: string | undefined;
let agent: Agent | undefined;

afterEach(async () => {
  try {
    await agent?.close();
  } finally {
    agent = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "teleharness-agent-"));
  const path = join(directory, "agent.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { provider, id: modelId } = faux.getModel();
  return {
    faux,
    async open() {
      agent = await openAgent(path, models, { provider, modelId });
      return agent;
    },
    async close() {
      await agent?.close();
      agent = undefined;
    },
  };
}

function blockGeneration() {
  const started = Promise.withResolvers<void>();
  const response: FauxResponseFactory = async (_transcript, options) => {
    const signal = options?.signal;
    if (!signal) {
      started.reject(new Error("Expected a provider abort signal"));
      throw new Error("Missing abort signal");
    }
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    started.resolve();
    await aborted;
    return fauxAssistantMessage("Interrupted attempt", { stopReason: "aborted" });
  };
  return { response, started: started.promise };
}

test("a duplicate request after reopening returns the original reply without a second model call", async () => {
  const fixtureDb = await fixture();
  fixtureDb.faux.setResponses([
    ({ messages }) => {
      const system = messages.filter((message) => message.role === "system");
      expect(system.some((message) => message.sections?.instructions?.includes("no tools"))).toBe(
        true,
      );
      expect(system.flatMap((message) => message.toolsAdded ?? [])).toEqual([]);
      return fauxAssistantMessage([fauxThinking("hidden"), fauxText("First"), fauxText("answer")]);
    },
  ]);

  const initial = await fixtureDb.open();
  const id = await initial.submit("telegram:1", "Hello");
  await expect.poll(() => initial.result(id)).toBe("First\nanswer");
  await fixtureDb.close();

  const reopened = await fixtureDb.open();
  expect(await reopened.submit("telegram:1", "Different text")).toBe(id);
  expect(await reopened.result(id)).toBe("First\nanswer");
  expect(fixtureDb.faux.state.callCount).toBe(1);
});

test("reopening resumes an interrupted generation without a new submission", async () => {
  const fixtureDb = await fixture();
  const blocked = blockGeneration();
  fixtureDb.faux.setResponses([blocked.response, fauxAssistantMessage("Resumed answer")]);
  const initial = await fixtureDb.open();
  const id = await initial.submit("telegram:2", "Please answer");
  await blocked.started;
  expect(await initial.result(id)).toBeUndefined();
  await fixtureDb.close();

  const reopened = await fixtureDb.open();
  await expect.poll(() => reopened.result(id)).toBe("Resumed answer");
  expect(fixtureDb.faux.state.callCount).toBe(2);
});

test("provider errors settle without exposing provider text", async () => {
  const fixtureDb = await fixture();
  fixtureDb.faux.setResponses([
    fauxAssistantMessage("Sensitive partial reply", {
      stopReason: "error",
      errorMessage: "Invalid API key: example-secret",
    }),
  ]);
  const opened = await fixtureDb.open();
  const id = await opened.submit("telegram:3", "Hello");
  await expect.poll(() => opened.result(id)).toBe("I couldn’t complete that request.");
});

test("stop settles both active and queued submissions as aborted", async () => {
  const fixtureDb = await fixture();
  const blocked = blockGeneration();
  fixtureDb.faux.setResponses([blocked.response]);
  const opened = await fixtureDb.open();
  const active = await opened.submit("telegram:4", "Active");
  await blocked.started;
  const queued = await opened.submit("telegram:5", "Queued");

  await opened.stop();
  expect(await opened.result(active)).toBe("Request stopped.");
  expect(await opened.result(queued)).toBe("Request stopped.");
  expect(fixtureDb.faux.state.callCount).toBe(1);
});
