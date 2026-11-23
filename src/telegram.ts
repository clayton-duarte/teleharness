import { z } from "zod";

const id = z
  .number()
  .int()
  .positive()
  .max(2 ** 52 - 1);
const update = z.object({
  update_id: id,
  message: z.object({
    forward_origin: z.never().optional(),
    chat: z.object({ id, type: z.literal("private") }),
    from: z.object({ id, is_bot: z.literal(false) }),
    text: z.string().trim().min(1).max(4096),
  }),
});

export type Owner = Readonly<{ userId: number; chatId: number }>;
export type TelegramRequest = {
  updateId: number;
  chatId: number;
} & ({ kind: "prompt"; text: string } | { kind: "status" | "stop" });

export function parseTelegramRequest(input: unknown, owner: Owner): TelegramRequest | null {
  const parsed = update.safeParse(input);
  if (!parsed.success) return null;

  const { update_id, message } = parsed.data;
  if (message.chat.id !== owner.chatId || message.from.id !== owner.userId) return null;

  const address = { updateId: update_id, chatId: message.chat.id };
  if (message.text === "/status") return { ...address, kind: "status" };
  if (message.text === "/stop") return { ...address, kind: "stop" };
  if (message.text.startsWith("/")) return null;
  return { ...address, kind: "prompt", text: message.text };
}
