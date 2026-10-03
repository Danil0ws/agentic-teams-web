import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalize } from '../utils/text.ts';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: MessageRole;
  text: string;
  ts: string;
  meta: Record<string, unknown>;
}

export interface Ticket {
  id: number;
  conversationId: string;
  subject: string;
  body: string;
  status: string;
  createdAt: string;
}

export interface MemoryStats {
  conversations: number;
  messages: number;
  tickets: number;
  handoffs: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Memória de longo prazo do agente em SQLite (node:sqlite, zero dependência).
 * Guarda conversas, turnos e chamados abertos por handoff.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly memory: boolean;

  constructor(path = ':memory:') {
    this.memory = path === ':memory:';
    if (!this.memory) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  ensureConversation(id: string, info: { channel: string; userId: string; userName: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations (id, channel, user_id, user_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, user_name = excluded.user_name`,
      )
      .run(id, info.channel, info.userId, info.userName, now, now);
  }

  appendMessage(conversationId: string, message: { role: MessageRole; text: string; meta?: Record<string, unknown>; ts?: string }): number {
    const result = this.db
      .prepare('INSERT INTO messages (conversation_id, role, text, ts, meta_json) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, message.role, message.text, message.ts ?? new Date().toISOString(), JSON.stringify(message.meta ?? {}));
    return Number(result.lastInsertRowid);
  }

  recentMessages(conversationId: string, limit = 10): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT id, conversation_id, role, text, ts, meta_json FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .all(conversationId, limit) as Array<Record<string, string | number>>;
    return rows.reverse().map((row) => this.toMessage(row));
  }

  /** Busca textual no histórico (usada para memória entre threads e auditoria). */
  search(query: string, limit = 5): StoredMessage[] {
    const needle = normalize(query);
    if (!needle) return [];
    const rows = this.db
      .prepare('SELECT id, conversation_id, role, text, ts, meta_json FROM messages ORDER BY id DESC LIMIT 500')
      .all() as Array<Record<string, string | number>>;
    return rows
      .map((row) => ({ row, score: normalize(String(row.text)).includes(needle) ? 1 : 0 }))
      .filter((entry) => entry.score > 0)
      .slice(0, limit)
      .map((entry) => this.toMessage(entry.row));
  }

  createTicket(ticket: { conversationId: string; subject: string; body: string; status?: string }): Ticket {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO tickets (conversation_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ticket.conversationId, ticket.subject, ticket.body, ticket.status ?? 'ABERTO', createdAt);
    return { id: Number(result.lastInsertRowid), conversationId: ticket.conversationId, subject: ticket.subject, body: ticket.body, status: ticket.status ?? 'ABERTO', createdAt };
  }

  /** Última atividade por conversa — alimenta o dashboard. */
  recentConversations(limit = 25): Array<Record<string, string | number>> {
    return this.db
      .prepare(
        `SELECT c.id, c.channel, c.user_name, c.last_seen_at,
                (SELECT m.text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS text,
                (SELECT m.ts   FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS ts
         FROM conversations c
         ORDER BY c.last_seen_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string | number>>;
  }

  listTickets(limit = 50): Ticket[] {
    const rows = this.db
      .prepare('SELECT id, conversation_id, subject, body, status, created_at FROM tickets ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: String(row.conversation_id),
      subject: String(row.subject),
      body: String(row.body),
      status: String(row.status),
      createdAt: String(row.created_at),
    }));
  }

  stats(): MemoryStats {
    const count = (table: string, where = ''): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get() as { total: number };
      return Number(row.total);
    };
    return {
      conversations: count('conversations'),
      messages: count('messages'),
      tickets: count('tickets'),
      handoffs: count('messages', "WHERE json_extract(meta_json, '$.handoff') = 1"),
    };
  }

  private toMessage(row: Record<string, string | number>): StoredMessage {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(String(row.meta_json ?? '{}')) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return {
      id: Number(row.id),
      conversationId: String(row.conversation_id),
      role: String(row.role) as MessageRole,
      text: String(row.text),
      ts: String(row.ts),
      meta,
    };
  }
}
