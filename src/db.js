import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS freelancers (
    chat_id     INTEGER PRIMARY KEY,
    name        TEXT,
    address     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id            TEXT PRIMARY KEY,
    chat_id       INTEGER,            -- NULL for invoices made on the website
    payee_name    TEXT NOT NULL,
    payee_address TEXT NOT NULL,
    client        TEXT NOT NULL,
    description   TEXT NOT NULL,
    amount_cents  INTEGER NOT NULL,   -- always stored in USD cents
    input_amount  REAL NOT NULL,      -- what the freelancer typed
    input_currency TEXT NOT NULL,     -- USD | GBP | NGN
    status        TEXT NOT NULL DEFAULT 'unpaid',
    txid          TEXT,
    paid_with     TEXT,               -- PUSD | BCH
    paid_at       INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invoices_by_chat ON invoices(chat_id, created_at);
`);

// Short, unambiguous ids for links: no 0/O/1/l/I.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
function newId(len = 8) {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const now = () => Date.now();

export const freelancers = {
  get: (chatId) => db.prepare('SELECT * FROM freelancers WHERE chat_id = ?').get(chatId),
  save: (chatId, name, address) =>
    db.prepare(`INSERT INTO freelancers (chat_id, name, address, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, address = excluded.address`)
      .run(chatId, name, address, now()),
};

export const invoices = {
  create({ chatId = null, payeeName, payeeAddress, client, description, amountCents, inputAmount, inputCurrency }) {
    const id = newId();
    db.prepare(`INSERT INTO invoices (id, chat_id, payee_name, payee_address, client, description,
                amount_cents, input_amount, input_currency, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chatId, payeeName, payeeAddress, client, description, amountCents, inputAmount, inputCurrency, now());
    return invoices.get(id);
  },
  get: (id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id),
  listForChat: (chatId, limit = 15) =>
    db.prepare('SELECT * FROM invoices WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit),
  markPaid(id, txid, paidWith) {
    const r = db.prepare(`UPDATE invoices SET status = 'paid', txid = ?, paid_with = ?, paid_at = ?
                          WHERE id = ? AND status = 'unpaid'`).run(txid, paidWith, now(), id);
    return r.changes === 1;
  },
  txidUsed: (txid) => !!db.prepare('SELECT 1 FROM invoices WHERE txid = ?').get(txid),
};
