import { DatabaseSync } from "node:sqlite";
import type { TelegramRequest } from "./telegram.ts";

export type BotIdentity = {
  botId: string;
  userId: number;
  chatId: number;
};

type Task = {
  id: number;
  thread: number;
  kind: TelegramRequest["kind"];
  text: string | null;
  submission: string | null;
};

type Reply = { id: number; thread: number; reply: string; attempts: number };
const maxAttempts = 4;

export function lockInstance(path: string) {
  const db = new DatabaseSync(path);
  try {
    // Hold an OS-backed SQLite lock for the process lifetime, released even on a crash.
    db.exec("BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new Error("Cannot lock state directory. Run only one instance per directory.");
  }
  return () => db.close();
}

export class State {
  private readonly db: DatabaseSync;

  constructor(path: string, identity: BotIdentity) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          bot TEXT NOT NULL,
          owner INTEGER NOT NULL,
          chat INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS delivery_gate (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          send_at INTEGER NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO delivery_gate VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS inbox (
          id INTEGER PRIMARY KEY,
          thread INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('prompt', 'status', 'stop')),
          text TEXT,
          state TEXT NOT NULL DEFAULT 'pending'
            CHECK (state IN ('pending', 'active', 'ready', 'delivered', 'failed')),
          submission TEXT,
          reply TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          retry_at INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_thread
          ON inbox(thread) WHERE state = 'active';
        CREATE INDEX IF NOT EXISTS by_state ON inbox(state, id);
      `);
      this.db
        .prepare("INSERT OR IGNORE INTO identity VALUES (1, ?, ?, ?)")
        .run(identity.botId, identity.userId, identity.chatId);
      const stored = this.db
        .prepare("SELECT 1 FROM identity WHERE bot = ? AND owner = ? AND chat = ?")
        .get(identity.botId, identity.userId, identity.chatId);
      if (!stored)
        throw new Error("State belongs to a different bot or owner; use a new state directory.");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  receive(requests: TelegramRequest[]) {
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO inbox (id, thread, kind, text) VALUES (?, ?, ?, ?)",
      );
      for (const request of requests) {
        insert.run(
          request.messageId,
          request.threadId ?? 0,
          request.kind,
          request.kind === "prompt" ? request.text : null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  active() {
    return this.db
      .prepare(
        "SELECT id, thread, kind, text, submission FROM inbox WHERE state = 'active' ORDER BY id",
      )
      .all() as Task[];
  }

  pending() {
    return this.db
      .prepare(
        "SELECT id, thread, kind, text, submission FROM inbox WHERE state = 'pending' ORDER BY id LIMIT 1",
      )
      .get() as Task | undefined;
  }

  activate(id: number) {
    this.db.prepare("UPDATE inbox SET state = 'active' WHERE id = ?").run(id);
  }

  submitted(id: number, submission: string) {
    this.db.prepare("UPDATE inbox SET submission = ? WHERE id = ?").run(submission, id);
  }

  reply(id: number, text: string) {
    const prefix = `#${id} `;
    // Keep UTF-16 pairs intact and fit comfortably within Telegram's text limit.
    const result =
      text.length > 3900 ? `${text.slice(0, 3900).replace(/[\uD800-\uDBFF]$/, "")}…` : text;
    this.db
      .prepare("UPDATE inbox SET state = 'ready', reply = ?, text = NULL WHERE id = ?")
      .run(prefix + result, id);
  }

  nextReply(now: number) {
    // A crash after reserving the last attempt leaves the outcome ambiguous.
    this.db
      .prepare("UPDATE inbox SET state = 'failed' WHERE state = 'ready' AND attempts >= ?")
      .run(maxAttempts);
    return this.db
      .prepare(`
        SELECT id, thread, reply, attempts FROM inbox
        WHERE state = 'ready' AND retry_at <= ? AND (SELECT send_at FROM delivery_gate) <= ?
        ORDER BY id LIMIT 1
      `)
      .get(now, now) as Reply | undefined;
  }

  reserveAttempt(id: number, now: number) {
    this.db.prepare("UPDATE delivery_gate SET send_at = ?").run(now + 1000);
    this.db.prepare("UPDATE inbox SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deliveryFailed(id: number, retryAt: number | null) {
    // Telegram rate limits apply to the destination chat, shared by all of its topics.
    if (retryAt !== null)
      this.db.prepare("UPDATE delivery_gate SET send_at = max(send_at, ?)").run(retryAt);
    this.db
      .prepare(
        "UPDATE inbox SET state = CASE WHEN ? IS NULL THEN 'failed' ELSE state END, retry_at = coalesce(?, 0) WHERE id = ?",
      )
      .run(retryAt, retryAt, id);
  }

  delivered(id: number) {
    this.db.prepare("UPDATE inbox SET state = 'delivered', reply = NULL WHERE id = ?").run(id);
  }

  failedCount(thread: number) {
    const row = this.db
      .prepare("SELECT count(*) AS count FROM inbox WHERE state = 'failed' AND thread = ?")
      .get(thread);
    return Number(row?.count ?? 0);
  }

  close() {
    this.db.close();
  }
}
