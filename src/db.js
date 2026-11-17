// Storage. Uses Postgres when DATABASE_URL is set (production), otherwise a local SQLite file (development).
// Every function is async so both backends look the same to the rest of the app.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const SCHEMA = (big, real) => [
  `CREATE TABLE IF NOT EXISTS freelancers (
    chat_id     ${big} PRIMARY KEY,
    name        TEXT,
    address     TEXT NOT NULL,
    created_at  ${big} NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id             TEXT PRIMARY KEY,
    chat_id        ${big},
    payee_name     TEXT NOT NULL,
    payee_address  TEXT NOT NULL,
    client         TEXT NOT NULL,
    description    TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL,
    input_amount   ${real} NOT NULL,
    input_currency TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'unpaid',
    txid           TEXT,
    paid_with      TEXT,
    paid_at        ${big},
    created_at     ${big} NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS invoices_by_chat ON invoices(chat_id, created_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS invoices_txid ON invoices(txid)',
];

// --- backend: { all(sql, params), get(sql, params), run(sql, params) -> changes } ---
async function postgresBackend(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (chat ids and ms timestamps fit safely)
  const pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  const toPg = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
  for (const stmt of SCHEMA('BIGINT', 'DOUBLE PRECISION')) await pool.query(stmt);
  console.log('Database: Postgres');
  return {
    all: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows,
    get: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0],
    run: async (sql, p = []) => (await pool.query(toPg(sql), p)).rowCount,
  };
}

async function sqliteBackend(path) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  for (const stmt of SCHEMA('INTEGER', 'REAL')) db.exec(stmt);
  const plain = (row) => (row ? { ...row } : row);
  return {
    all: async (sql, p = []) => db.prepare(sql).all(...p).map(plain),
    get: async (sql, p = []) => plain(db.prepare(sql).get(...p)),
    run: async (sql, p = []) => db.prepare(sql).run(...p).changes,
  };
}

const db = process.env.DATABASE_URL
  ? await postgresBackend(process.env.DATABASE_URL)
  : await sqliteBackend(config.dbPath);

// Short, unambiguous ids for links: no 0/O/1/l/I.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
function newId(len = 8) {
  return Array.from(randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');
}
const now = () => Date.now();

export const freelancers = {
  get: (chatId) => db.get('SELECT * FROM freelancers WHERE chat_id = ?', [chatId]),
  save: (chatId, name, address) => db.run(
    `INSERT INTO freelancers (chat_id, name, address, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (chat_id) DO UPDATE SET name = excluded.name, address = excluded.address`,
    [chatId, name, address, now()]),
};

export const invoices = {
  async create({ chatId = null, payeeName, payeeAddress, client, description, amountCents, inputAmount, inputCurrency }) {
    const id = newId();
    await db.run(
      `INSERT INTO invoices (id, chat_id, payee_name, payee_address, client, description,
         amount_cents, input_amount, input_currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, chatId, payeeName, payeeAddress, client, description, amountCents, inputAmount, inputCurrency, now()]);
    return invoices.get(id);
  },
  get: (id) => db.get('SELECT * FROM invoices WHERE id = ?', [id]),
  listForChat: (chatId, limit = 15) =>
    db.all('SELECT * FROM invoices WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?', [chatId, limit]),
  async markPaid(id, txid, paidWith) {
    return (await db.run(
      `UPDATE invoices SET status = 'paid', txid = ?, paid_with = ?, paid_at = ? WHERE id = ? AND status = 'unpaid'`,
      [txid, paidWith, now(), id])) === 1;
  },
  async txidUsed(txid) { return !!(await db.get('SELECT 1 AS x FROM invoices WHERE txid = ?', [txid])); },
  async deleteUnpaid(id, chatId) {
    return (await db.run(`DELETE FROM invoices WHERE id = ? AND chat_id = ? AND status = 'unpaid'`, [id, chatId])) === 1;
  },
};
