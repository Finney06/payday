// Run: npm test
process.env.DB_PATH = './data/test-payments.db';
process.env.BOT_TOKEN = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTransaction, hexToBin, binToHex, hash160, encodeLockingBytecodeP2pkh, secp256k1 } from '@bitauth/libauth';
import { buildPayment, opReturnInvoice, TOKEN_DUST, PaymentError } from '../shared/tx.js';

const PUSD = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const OTHER = 'aa'.repeat(32);

function key(n) {
  const priv = new Uint8Array(32); priv[31] = n;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  return encodeLockingBytecodeP2pkh(hash160(pub));
}
const payer = key(1), change = key(2), payee = key(3);
const txid = (n) => n.toString(16).padStart(64, '0');

const wallet = [
  { txid: txid(1), vout: 0, value: 50_000n, token: null, lockingBytecode: payer, path: 'receive', index: 0 },
  { txid: txid(2), vout: 1, value: 1000n, token: { category: PUSD, amount: 3000n, nft: null }, lockingBytecode: payer, path: 'receive', index: 1 },
  { txid: txid(3), vout: 0, value: 1000n, token: { category: PUSD, amount: 2500n, nft: null }, lockingBytecode: payer, path: 'change', index: 0 },
  { txid: txid(4), vout: 0, value: 1000n, token: { category: OTHER, amount: 9n, nft: null }, lockingBytecode: payer, path: 'receive', index: 2 },
];

test('PUSD payment: pays exact tokens, returns token change, tags invoice, never spends other tokens', () => {
  const b = buildPayment({ utxos: wallet, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 5000n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: 'abc12345' });
  const tx = decodeTransaction(hexToBin(b.hex));
  const toPayee = tx.outputs.filter((o) => binToHex(o.lockingBytecode) === binToHex(payee));
  assert.equal(toPayee.length, 1);
  assert.equal(toPayee[0].token.amount, 5000n);
  assert.equal(binToHex(toPayee[0].token.category), PUSD);
  assert.equal(toPayee[0].valueSatoshis, TOKEN_DUST);
  const tokenChange = tx.outputs.find((o) => o.token && binToHex(o.lockingBytecode) === binToHex(change));
  assert.equal(tokenChange.token.amount, 500n);
  assert.ok(tx.outputs.some((o) => binToHex(o.lockingBytecode) === binToHex(opReturnInvoice('abc12345'))));
  assert.ok(!b.sourceOutputs.some((s) => s.token && binToHex(s.token.category) === OTHER), 'must not spend other tokens');
  // tokens in == tokens out
  const tin = b.sourceOutputs.filter((s) => s.token).reduce((a, s) => a + s.token.amount, 0n);
  const tout = tx.outputs.filter((o) => o.token).reduce((a, o) => a + o.token.amount, 0n);
  assert.equal(tin, tout);
  assert.ok(b.fee > 0n && b.fee < 2000n, `fee ${b.fee}`);
  assert.deepEqual(b.inputPaths.map((p) => p[1]).sort(), ['change', 'receive', 'receive'].sort());
});

test('BCH payment: pays amount, adds change, no token inputs', () => {
  const b = buildPayment({ utxos: wallet, method: 'BCH', payeeLockingBytecode: payee, amountSats: 20_000n, changeLockingBytecode: change, invoiceId: 'zz' });
  const tx = decodeTransaction(hexToBin(b.hex));
  assert.equal(tx.outputs.find((o) => binToHex(o.lockingBytecode) === binToHex(payee)).valueSatoshis, 20_000n);
  assert.ok(b.sourceOutputs.every((s) => !s.token));
  assert.ok(tx.outputs.some((o) => binToHex(o.lockingBytecode) === binToHex(change) && o.valueSatoshis > 29_000n));
});

test('clear errors when the wallet is short', () => {
  assert.throws(() => buildPayment({ utxos: wallet, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 9000n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: 'x' }),
    (e) => e instanceof PaymentError && e.code === 'NOT_ENOUGH_PUSD' && /55\.00 ParyonUSD/.test(e.message));
  assert.throws(() => buildPayment({ utxos: wallet, method: 'BCH', payeeLockingBytecode: payee, amountSats: 900_000n, changeLockingBytecode: change, invoiceId: 'x' }),
    (e) => e.code === 'NOT_ENOUGH_BCH');
  const tokensOnly = wallet.filter((u) => u.token);
  assert.throws(() => buildPayment({ utxos: tokensOnly, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 1000n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: 'x' }),
    (e) => e.code === 'NOT_ENOUGH_BCH' || e.code === undefined);
});

test('server rejects underpayment and payments for another invoice', async () => {
  const { invoices } = await import('../src/db.js');
  const { submitPayment } = await import('../src/payments.js');
  const { lockingBytecodeToCashAddress } = await import('@bitauth/libauth');
  const payeeAddr = lockingBytecodeToCashAddress({ bytecode: payee, prefix: 'bitcoincash', tokenSupport: true }).address;
  const inv = await invoices.create({ payeeName: 'Test', payeeAddress: payeeAddr, client: 'Sarah', description: 'logo', amountCents: 5000, inputAmount: 50, inputCurrency: 'USD' });

  const short = buildPayment({ utxos: wallet, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 4999n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: inv.id });
  await assert.rejects(submitPayment(inv, short.hex, 'PUSD'), /less than the invoice/);

  const other = buildPayment({ utxos: wallet, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 5000n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: 'someother' });
  await assert.rejects(submitPayment(inv, other.hex, 'PUSD'), /not linked to this invoice/);

  // A correct (but unsigned, fake-coin) payment passes our checks and is then rejected by the real network.
  const good = buildPayment({ utxos: wallet, method: 'PUSD', payeeLockingBytecode: payee, tokenAmount: 5000n, tokenCategory: PUSD, changeLockingBytecode: change, invoiceId: inv.id });
  await assert.rejects(submitPayment(inv, good.hex, 'PUSD'), /network rejected|Could not reach/);
  assert.equal((await invoices.get(inv.id)).status, 'unpaid');
  setTimeout(() => process.exit(0), 100);
});
