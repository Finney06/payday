import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSats, findPayment, bip21 } from '../src/plain.js';

test('the exact amount is the quote plus 1-999 sats', () => {
  for (const base of [1, 999, 1000, 24539, 250000]) {
    for (const id of ['abc', 'b6czvg3p', 'zzzzzzzz']) {
      const s = uniqueSats(base, id);
      assert.ok(s > base, `${s} > ${base}`);
      assert.ok(s - base >= 1 && s - base <= 999);
    }
  }
});

test('two open invoices to the same wallet never share an amount', () => {
  const taken = new Set();
  for (let i = 0; i < 300; i++) {
    const s = uniqueSats(24539, `inv${i}`, taken);
    assert.ok(!taken.has(s));
    taken.add(s);
  }
});

test('a payment is matched only by its exact amount in plain BCH', () => {
  const utxos = [
    { tx_hash: 'a', value: 25000, height: 0 },
    { tx_hash: 'b', value: 25123, height: 0, token_data: { category: 'x', amount: '5' } },
    { tx_hash: 'c', value: 25123, height: 0 },
  ];
  assert.equal(findPayment(utxos, 25123)?.tx_hash, 'c');
  assert.equal(findPayment(utxos, 25122), null); // underpaid by 1 sat: not this invoice
  assert.equal(findPayment(utxos, 25124), null);
});

test('a coin already used by another invoice does not count', () => {
  const utxos = [{ tx_hash: 'old', value: 25123, height: 0 }, { tx_hash: 'new', value: 25123, height: 0 }];
  assert.equal(findPayment(utxos, 25123, (t) => t === 'old')?.tx_hash, 'new');
  assert.equal(findPayment(utxos, 25123, () => true), null);
});

test('an old coin from before the QR code was shown does not count', () => {
  const utxos = [{ tx_hash: 'old', value: 25123, height: 900000 }];
  assert.equal(findPayment(utxos, 25123, () => false, 975300), null);
  assert.equal(findPayment([{ tx_hash: 'new', value: 25123, height: 975301 }], 25123, () => false, 975300)?.tx_hash, 'new');
  assert.equal(findPayment([{ tx_hash: 'mem', value: 25123, height: 0 }], 25123, () => false, 975300)?.tx_hash, 'mem');
});

test('the QR code asks for the exact amount', () => {
  assert.equal(bip21({ address: 'bitcoincash:qzhuv665eghtsamz4n4hhjjwkwutruu5s59tnghpeu', sats: 25123 }),
    'bitcoincash:qzhuv665eghtsamz4n4hhjjwkwutruu5s59tnghpeu?amount=0.00025123');
  assert.equal(bip21({ address: 'bitcoincash:q', sats: 100000000 }), 'bitcoincash:q?amount=1');
});
