import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";

test("serves health without enabling a public ingress route", async () => {
  const app = createApp();
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect((await app.request("/webhook", { method: "POST" })).status).toBe(404);
});

test("readiness is independent from process health", async () => {
  let ready = false;
  const app = createApp(() => ready);
  expect((await app.request("/readyz")).status).toBe(503);
  expect((await app.request("/healthz")).status).toBe(200);
  ready = true;
  expect((await app.request("/readyz")).status).toBe(200);
});
