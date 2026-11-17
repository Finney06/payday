// End-to-end payment test: plays the client's wallet against a running Payday server.
// It uses the same HTTP API as the pay page and the same payment builder (shared/tx.js),
// signs locally instead of through WizardConnect, and checks the invoice ends up Paid on chain.
//
//   node scripts/e2e-pay.mjs --base http://localhost:3200 --network chipnet [--usd 0.01] [--method BCH]
//
// The payer key lives in .test-wallet.json (gitignored). Fund its address before running.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  decodePrivateKeyWif, encodePrivateKeyWif, generatePrivateKey, secp256k1, hash160, hash256,
  encodeLockingBytecodeP2pkh, encodeCashAddress, cashAddressToLockingBytecode, hexToBin, binToHex,
  decodeTransaction, encodeTransaction, encodeDataPush, generateSigningSerializationBch,
  SigningSerializationTypeBch, createVirtualMachineBch,
} from '@bitauth/libauth';
import { buildPayment } from '../shared/tx.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const BASE = arg('base', 'http://localhost:3200').replace(/\/$/, '');
const NETWORK = arg('network', 'chipnet');
const USD = Number(arg('usd', '0.01'));
const METHOD = arg('method', 'BCH');
const PREFIX = NETWORK === 'mainnet' ? 'bitcoincash' : 'bchtest';
const WALLET_FILE = '.test-wallet.json';

const step = (n, msg) => console.log(`\n${n}. ${msg}`);
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => { console.error(`\n✗ FAILED: ${msg}`); process.exit(1); };

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ---------- keys ----------
function keyFrom(wif) {
  const d = decodePrivateKeyWif(wif);
  if (typeof d === 'string') fail(`bad key in ${WALLET_FILE}: ${d}`);
  const pub = secp256k1.derivePublicKeyCompressed(d.privateKey);
  const lockingBytecode = encodeLockingBytecodeP2pkh(hash160(pub));
  const a = encodeCashAddress({ prefix: PREFIX, type: 'p2pkh', payload: hash160(pub) });
  return { priv: d.privateKey, pub, lockingBytecode, address: typeof a === 'string' ? a : a.address };
}

if (!existsSync(WALLET_FILE)) fail(`${WALLET_FILE} not found (create and fund a test wallet first).`);
const w = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (!w.payeeWifChipnet) { // a second key that receives the payment, so "paid" can't be confused with change
  const k = generatePrivateKey();
  w.payeeWifChipnet = encodePrivateKeyWif(k, 'testnet');
  w.payeeWifMainnet = encodePrivateKeyWif(k, 'mainnet');
  writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2));
}
const payer = keyFrom(NETWORK === 'mainnet' ? w.wifMainnet : w.wifChipnet);
const payee = keyFrom(NETWORK === 'mainnet' ? w.payeeWifMainnet : w.payeeWifChipnet);

// ---------- signing (P2PKH, Schnorr, SIGHASH_ALL|FORKID) ----------
function signP2pkh(unsignedHex, sourceOutputs) {
  const tx = decodeTransaction(hexToBin(unsignedHex));
  if (typeof tx === 'string') fail(`could not decode built tx: ${tx}`);
  const type = SigningSerializationTypeBch.allOutputs;
  tx.inputs.forEach((input, inputIndex) => {
    const serialization = generateSigningSerializationBch(
      { inputIndex, sourceOutputs, transaction: tx },
      { coveredBytecode: sourceOutputs[inputIndex].lockingBytecode, signingSerializationType: Uint8Array.of(type) },
    );
    const sig = secp256k1.signMessageHashSchnorr(payer.priv, hash256(serialization));
    if (typeof sig === 'string') fail(`signing failed: ${sig}`);
    input.unlockingBytecode = Uint8Array.from([...encodeDataPush(Uint8Array.from([...sig, type])), ...encodeDataPush(payer.pub)]);
  });
  // Verify with the Bitcoin Cash VM before anything leaves this machine.
  const vm = createVirtualMachineBch();
  const verdict = vm.verify({ transaction: tx, sourceOutputs });
  if (verdict !== true) fail(`local VM rejected the signed transaction: ${verdict}`);
  return binToHex(encodeTransaction(tx));
}

// ---------- the run ----------
console.log(`Payday end-to-end payment test · ${NETWORK} · ${BASE}`);
console.log(`payer ${payer.address}\npayee ${payee.address}`);

step(1, 'Server is up and on the right network');
const cfg = await api('/api/config');
if (!cfg.ok) fail(`GET /api/config -> ${cfg.status}`);
if (cfg.data.network !== NETWORK) fail(`server is on ${cfg.data.network}, test expects ${NETWORK}`);
ok(`network ${cfg.data.network}`);

step(2, `Freelancer creates a $${USD} invoice on the website`);
const created = await api('/api/invoices', { name: 'E2E Test', address: payee.address, client: 'Test client', description: 'end-to-end test', amount: USD, currency: 'USD' });
if (!created.ok) fail(`POST /api/invoices -> ${created.status} ${created.data.error || ''}`);
const inv = created.data;
ok(`invoice ${inv.id} for ${inv.amountCents}¢, pay link ${inv.payUrl}`);

step(3, 'Client opens the pay link');
const opened = await api(`/api/invoice/${inv.id}`);
if (!opened.ok || opened.data.status !== 'unpaid') fail(`invoice not readable or not unpaid: ${JSON.stringify(opened.data)}`);
ok(`status ${opened.data.status}, pays to ${opened.data.payeeAddress}`);

step(4, "Client's wallet coins are read through Payday");
const u = await api('/api/utxos', { addresses: [payer.address] });
if (!u.ok) fail(`POST /api/utxos -> ${u.status} ${u.data.error || ''}`);
const utxos = (u.data[payer.address] || []).map((x) => ({
  txid: x.txid, vout: x.vout, value: BigInt(x.value), height: x.height,
  token: x.token ? { category: x.token.category, amount: BigInt(x.token.amount), nft: x.token.nft } : null,
  lockingBytecode: payer.lockingBytecode, path: 'receive', index: 0,
}));
const bal = utxos.filter((x) => !x.token).reduce((s, x) => s + x.value, 0n);
if (!utxos.length) fail(`payer has no coins. Fund ${payer.address} first.`);
ok(`${utxos.length} coin(s), ${bal} sats`);

step(5, 'Pay page gets the locked BCH quote');
const q = await api(`/api/invoice/${inv.id}/quote`);
if (!q.ok || !q.data.sats) fail(`quote failed: ${q.data.error || q.status}`);
ok(`${q.data.sats} sats at $${q.data.bchUsd}/BCH, locked until ${new Date(q.data.expiresAt).toLocaleTimeString()}`);

step(6, 'Wallet builds (shared/tx.js) and signs the payment');
const built = buildPayment({
  utxos, method: METHOD, payeeLockingBytecode: payee.lockingBytecode, amountSats: BigInt(q.data.sats),
  tokenAmount: BigInt(inv.amountCents), tokenCategory: cfg.data.pusdCategory,
  changeLockingBytecode: payer.lockingBytecode, invoiceId: inv.id,
});
const signedHex = signP2pkh(built.hex, built.sourceOutputs);
ok(`fee ${built.fee} sats, ${signedHex.length / 2} bytes, verified by the local BCH VM`);

step(7, 'Safety check: Payday refuses a payment that is too small');
const shortBuilt = buildPayment({
  utxos, method: 'BCH', payeeLockingBytecode: payee.lockingBytecode, amountSats: BigInt(Math.max(546, Math.floor(q.data.sats / 2))),
  changeLockingBytecode: payer.lockingBytecode, invoiceId: inv.id,
});
const shortRes = await api(`/api/invoice/${inv.id}/submit`, { txHex: signP2pkh(shortBuilt.hex, shortBuilt.sourceOutputs), method: 'BCH' });
if (shortRes.ok) fail('server ACCEPTED an underpayment');
ok(`refused (${shortRes.status}): ${shortRes.data.error}`);

step(8, 'Payday verifies and broadcasts the real payment');
const sub = await api(`/api/invoice/${inv.id}/submit`, { txHex: signedHex, method: METHOD });
if (!sub.ok) fail(`submit -> ${sub.status} ${sub.data.error || ''}`);
if (sub.data.status !== 'paid') fail(`invoice not paid after submit: ${JSON.stringify(sub.data)}`);
ok(`invoice ${inv.id} is PAID, txid ${sub.data.txid}`);

step(9, 'The paid invoice can be read back (what an open pay page sees)');
const after = await api(`/api/invoice/${inv.id}`);
if (after.data.status !== 'paid' || after.data.txid !== sub.data.txid) fail('invoice did not stay paid');
ok(`status ${after.data.status}, paid with ${after.data.paidWith}`);

step(10, 'Safety check: the same payment cannot be used twice');
const again = await api(`/api/invoice/${inv.id}/submit`, { txHex: signedHex, method: METHOD });
if (again.ok) fail('server accepted the same payment twice');
ok(`refused (${again.status}): ${again.data.error}`);

const explorer = NETWORK === 'mainnet' ? 'https://explorer.bch.ninja/tx/' : 'https://chipnet.chaingraph.cash/tx/';
console.log(`\n✅ END-TO-END PASSED on ${NETWORK}\n   ${explorer}${sub.data.txid}`);
process.exit(0);
