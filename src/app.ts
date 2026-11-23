import { Hono } from "hono";

export function createApp(ready: () => boolean = () => false) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) =>
    ready() ? c.json({ status: "ready" }) : c.json({ status: "not_ready" }, 503),
  );
  return app;
}
