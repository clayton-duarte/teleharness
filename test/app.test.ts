import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";

test("serves health without enabling a public ingress route", async () => {
  const app = createApp();
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect((await app.request("/webhook", { method: "POST" })).status).toBe(404);
});
