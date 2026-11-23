import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "./app.ts";

const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? "3000");
const app = createApp();
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
