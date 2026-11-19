import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_TOKEN = '';
process.env.DATABASE_URL = '';
process.env.BASE_URL = 'https://payday.example';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'payday-test-')), 'test.db');

const { invoiceKeyboard, shareKeyboard, moreKeyboard } = await import('../src/bot.js');
const labels = (kb) => kb.inline_keyboard.map((row) => row.map((button) => button.text));
const inv = { id: 'abc12345' };

test('a new invoice shows a short set of buttons', () => {
  assert.deepEqual(labels(invoiceKeyboard(inv)), [['📤 Send to client'], ['📄 PDF', '⋯ More']]);
});

test('sharing and extra actions open separately', () => {
  assert.deepEqual(labels(shareKeyboard(inv, 'Hi', { back: true })), [['WhatsApp', 'Telegram'], ['Email'], ['← Back']]);
  assert.deepEqual(labels(moreKeyboard(inv)), [['Open pay page'], ['Delete invoice'], ['← Back']]);
  assert.equal(shareKeyboard(inv, 'Hi').inline_keyboard[1][0].url, 'https://payday.example/email/abc12345');
});
