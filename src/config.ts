import { z } from "zod";
import { resolveModel } from "./agent.ts";

const id = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(
    z
      .int()
      .min(1)
      .max(2 ** 52 - 1),
  );
const config = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[1-9][0-9]*:[A-Za-z0-9_-]+$/),
  TELEGRAM_USER_ID: id,
  TELEGRAM_CHAT_ID: id,
  TELEHARNESS_MODEL: z.string().trim().min(1),
  TELEHARNESS_STATE_DIR: z.string().trim().min(1).default(".teleharness"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export class ConfigError extends Error {}

export function parseConfig(env: NodeJS.ProcessEnv) {
  const parsed = config.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new ConfigError(`Missing or invalid configuration: ${keys.join(", ")}`);
  }
  const { TELEGRAM_BOT_TOKEN: token, ...envConfig } = parsed.data;
  const botId = token.slice(0, token.indexOf(":"));
  if (
    botId === String(envConfig.TELEGRAM_CHAT_ID) ||
    botId === String(envConfig.TELEGRAM_USER_ID)
  ) {
    throw new ConfigError(
      "A Telegram ID is set to the bot's own ID. Run pnpm telegram:pair to find your private chat and sender IDs.",
    );
  }
  const model = resolveModel(envConfig.TELEHARNESS_MODEL);
  if (!model) throw new ConfigError("TELEHARNESS_MODEL must name a supported chat model.");

  // Pi reads the injected key directly from the environment when making requests.
  const key = model.provider === "openai" ? "OPENAI_API_KEY" : "OPENCODE_API_KEY";
  if (!env[key]?.trim()) throw new ConfigError(`Missing or invalid configuration: ${key}`);

  return {
    token,
    owner: { userId: envConfig.TELEGRAM_USER_ID, chatId: envConfig.TELEGRAM_CHAT_ID },
    botId,
    model,
    directory: envConfig.TELEHARNESS_STATE_DIR,
    port: envConfig.PORT,
  };
}
