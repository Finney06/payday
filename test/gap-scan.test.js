import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapScan } from '../client/wallet.js';

// a fake wallet: each chain has addresses "<chain>-<index>"; `history` says which were ever used, `coins` which hold money
const fakeServer = (history, coins, unknown = false) => {
  let calls = 0;
  const fetchBatch = async (addresses) => {
    calls++;
    return {
      utxos: Object.fromEntries(addresses.map((a) => [a, coins[a] ? [{ txid: a, vout: 0, value: String(coins[a]) }] : []])),
      used: Object.fromEntries(addresses.map((a) => [a, unknown ? null : (history.has(a) || !!coins[a])])),
    };
  };
  return { fetchBatch, calls: () => calls };
};
const addressAt = (c, i) => ({ address: `${c.name}-${i}`, bytecode: new Uint8Array() });
const chains = [{ name: 'receive', child: 0 }, { name: 'change', child: 1 }];

test('finds money far past the first 20 addresses in a well-used wallet', async () => {
  const history = new Set(Array.from({ length: 50 }, (_, i) => `receive-${i}`));
  const srv = fakeServer(history, { 'receive-47': 543000 });
  const found = await gapScan(chains, addressAt, srv.fetchBatch);
  assert.deepEqual(found.map((f) => f.s.address), ['receive-47']);
  assert.equal(found[0].s.index, 47);
});

test('a fresh wallet stops after one batch per chain', async () => {
  const srv = fakeServer(new Set(), { 'receive-0': 30000 });
  const found = await gapScan(chains, addressAt, srv.fetchBatch);
  assert.equal(found.length, 1);
  assert.equal(srv.calls(), 3); // receive: 0-19 (used) then 20-39 (no history) -> stop; change: 0-19 -> stop
});

test('keeps going past emptied addresses, stops at the first batch with no history', async () => {
  const history = new Set(['receive-3', 'receive-25']);
  const srv = fakeServer(history, {});
  await gapScan([chains[0]], addressAt, srv.fetchBatch);
  assert.equal(srv.calls(), 3); // 0-19 (3 used), 20-39 (25 used), 40-59 (none) -> stop
});

test('if the server cannot tell, it still stops at 200 addresses per chain', async () => {
  const srv = fakeServer(new Set(), {}, true);
  await gapScan([chains[0]], addressAt, srv.fetchBatch);
  assert.equal(srv.calls(), 10);
});
