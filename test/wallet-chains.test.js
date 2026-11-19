import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPublicNode, encodeHdPublicKey, hexToBin, binToHex,
} from '@bitauth/libauth';
import { readChains } from '../client/wallet.js';

const root = deriveHdPrivateNodeFromSeed(hexToBin('000102030405060708090a0b0c0d0e0f'));
const xpubAt = (path) => {
  const node = deriveHdPath(root, path);
  return encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(node) }).hdPublicKey;
};
const receive = xpubAt("m/44'/145'/0'/0");
const change = xpubAt("m/44'/145'/0'/1");
const account = xpubAt("m/44'/145'/0'");
const key = (node) => binToHex(node.publicKey);

test('standard receive and change names', () => {
  const { chains } = readChains([{ name: 'receive', xpub: receive }, { name: 'change', xpub: change }]);
  assert.deepEqual(chains.map((c) => [c.name, c.child]), [['receive', 0], ['change', 1]]);
});

test('other names keep the wallet name and map by meaning or order', () => {
  const a = readChains([{ name: 'External', xpub: receive }, { name: 'Internal', xpub: change }]).chains;
  assert.deepEqual(a.map((c) => [c.name, c.child]), [['External', 0], ['Internal', 1]]);
  const b = readChains([{ name: 'p1', xpub: receive }, { name: 'p2', xpub: change }]).chains;
  assert.deepEqual(b.map((c) => c.child), [0, 1]);
});

test('an account-level key derives the receive step', () => {
  const { chains } = readChains([{ name: 'receive', xpub: account }]);
  const direct = readChains([{ name: 'receive', xpub: receive }]).chains[0];
  assert.equal(key(chains[0].node), key(direct.node));
});

test('defi paths are skipped and bad keys are reported', () => {
  const { chains, problems } = readChains([{ name: 'defi', xpub: receive }, { name: 'receive', xpub: 'nope' }]);
  assert.equal(chains.length, 0);
  assert.equal(problems.length, 1);
});
