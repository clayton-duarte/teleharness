import { pairTelegram } from "./pairing.ts";

process.exitCode = await pairTelegram(process.env.TELEGRAM_BOT_TOKEN);
