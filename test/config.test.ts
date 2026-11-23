import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "123:fake-token",
  TELEGRAM_USER_ID: "1099511627776",
  TELEGRAM_CHAT_ID: "42",
  OPENCODE_API_KEY: "fake-key",
  TELEHARNESS_MODEL: "claude-opus-4-6",
};

test("binds state to the bot identity without putting secrets in the identity", () => {
  expect(parseConfig(env)).toEqual({
    token: env.TELEGRAM_BOT_TOKEN,
    owner: { userId: 2 ** 40, chatId: 42 },
    botId: "123",
    model: { provider: "opencode", modelId: "claude-opus-4-6" },
    directory: ".teleharness",
    port: 3000,
  });
});

test("accepts pasted IDs with surrounding whitespace without accepting embedded spaces", () => {
  expect(
    parseConfig({ ...env, TELEGRAM_USER_ID: " 42\n", TELEGRAM_CHAT_ID: "\t42 " }).owner,
  ).toEqual({
    userId: 42,
    chatId: 42,
  });
  expect(() => parseConfig({ ...env, TELEGRAM_USER_ID: "4 2" })).toThrow(/TELEGRAM_USER_ID/);
});

test.each(["TELEGRAM_USER_ID", "TELEGRAM_CHAT_ID"])("rejects the bot's own ID in %s", (key) => {
  expect(() => parseConfig({ ...env, [key]: "123" })).toThrow(/bot's own ID/);
});

test.each([
  [" gpt-5.6-luna ", "opencode", "gpt-5.6-luna"],
  ["opencode/gpt-5.6-luna", "opencode", "gpt-5.6-luna"],
  ["opencode-go/gpt-5.6-luna", "opencode-go", "gpt-5.6-luna"],
  ["qwen4-max", "opencode-go", "qwen4-max"],
])("resolves %s against the bundled chat catalogs", (value, provider, modelId) => {
  expect(parseConfig({ ...env, TELEHARNESS_MODEL: value }).model).toEqual({ provider, modelId });
});

test.each([
  ["gpt-4.1-mini", "gpt-4.1-mini"],
  ["openai/gpt-5.6-luna", "gpt-5.6-luna"],
])("retains OpenAI support for %s without requiring an OpenCode key", (value, modelId) => {
  expect(
    parseConfig({
      ...env,
      OPENCODE_API_KEY: undefined,
      OPENAI_API_KEY: "fake-openai-key",
      TELEHARNESS_MODEL: value,
    }).model,
  ).toEqual({ provider: "openai", modelId });
});

test.each([
  ["gpt-5.6-luna", "OPENCODE_API_KEY", "OPENAI_API_KEY", undefined],
  ["opencode-go/qwen4-max", "OPENCODE_API_KEY", "OPENAI_API_KEY", " "],
  ["openai/gpt-5.6-luna", "OPENAI_API_KEY", "OPENCODE_API_KEY", undefined],
])("requires only the selected provider's key for %s", (value, required, other, missing) => {
  expect(() =>
    parseConfig({ ...env, TELEHARNESS_MODEL: value, [other]: "other-key", [required]: missing }),
  ).toThrow(new RegExp(`^Missing or invalid configuration: ${required}$`));
});

test.each(["other/private-value", "opencode/private-value", "opencode/qwen4-max", "opencode-go/"])(
  "rejects invalid model selection without echoing it (%s)",
  (value) => {
    expect(() => parseConfig({ ...env, TELEHARNESS_MODEL: value })).toThrow(
      /^TELEHARNESS_MODEL must name a supported chat model\.$/,
    );
  },
);

test("invalid environment errors list only key names", () => {
  expect(() =>
    parseConfig({ ...env, TELEGRAM_BOT_TOKEN: "oops?secret", TELEGRAM_CHAT_ID: "4e2" }),
  ).toThrow(/^Missing or invalid configuration: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID$/);
});
