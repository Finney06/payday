// "Pay with any wallet": a plain BCH QR code (BIP21) for wallets without WizardConnect.
// A plain payment can't carry Payday's invoice tag, so each invoice gets its own exact amount
// (a few extra satoshis), and Payday watches the freelancer's address for that amount.
import { createHash } from 'node:crypto';
import { invoices } from './db.js';
import { normalizeAddress, scripthashOf } from './address.js';
import { chain } from './chain.js';
import { quoteBch } from './payments.js';

const WATCH_FOR = 60 * 60 * 1000; // keep looking for a plain payment for an hour
const plainQuotes = new Map(); // invoiceId -> { sats, scripthash, payeeHex, address, at, until }

// The invoice's exact amount: the quote plus 1-999 sats (at most a fraction of a cent) picked from the
// invoice id. `taken` holds amounts other open invoices to the same address already use.
export function uniqueSats(baseSats, invoiceId, taken = new Set()) {
  const start = Math.ceil(baseSats);
  let offset = (createHash('sha256').update(String(invoiceId)).digest().readUInt16BE(0) % 999) + 1;
  for (let i = 0; i < 999 && taken.has(start + offset); i++) offset = (offset % 999) + 1;
  return start + offset;
}

// The coin that pays this invoice: exactly the amount, plain BCH, not already used by another invoice, and
// new: still unconfirmed, or confirmed no earlier than the block the QR code was shown in.
export function findPayment(utxos, sats, isUsed = () => false, sinceHeight = null) {
  const fresh = (u) => sinceHeight == null || !(u.height > 0) || u.height >= sinceHeight;
  return utxos.find((u) => Number(u.value) === sats && !u.token_data && fresh(u) && !isUsed(u.tx_hash)) || null;
}

export async function plainQuote(inv) {
  const now = Date.now();
  const have = plainQuotes.get(inv.id);
  if (have && now < have.until) return have;
  const payee = normalizeAddress(inv.payee_address);
  const { sats: base } = await quoteBch(inv);
  const taken = new Set([...plainQuotes.values()].filter((q) => q.payeeHex === payee.lockingBytecodeHex && now < q.until).map((q) => q.sats));
  const q = {
    sats: uniqueSats(base, inv.id, taken),
    scripthash: scripthashOf(inv.payee_address),
    payeeHex: payee.lockingBytecodeHex,
    address: payee.address,
    sinceHeight: await chain.tipHeight(),
    at: now,
    until: now + WATCH_FOR,
  };
  plainQuotes.set(inv.id, q);
  return q;
}

export function bip21(q) {
  return `${q.address}?amount=${(q.sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// Looks once for the plain payment. Returns the updated invoice when it was just paid, else null.
export async function checkPlain(inv) {
  const q = plainQuotes.get(inv.id);
  if (!q || inv.status === 'paid') return null;
  const utxos = await chain.listUnspent(q.scripthash);
  const used = new Set();
  for (const u of utxos) if (Number(u.value) === q.sats && await invoices.txidUsed(u.tx_hash)) used.add(u.tx_hash);
  const coin = findPayment(utxos, q.sats, (txid) => used.has(txid), q.sinceHeight);
  if (!coin) return null;
  if (!(await invoices.markPaid(inv.id, coin.tx_hash, 'BCH'))) return null;
  plainQuotes.delete(inv.id);
  return invoices.get(inv.id);
}

// Checks every open plain QR invoice now and then, so a payer can close the page after paying.
export function startPlainWatcher(onPaid, every = 15_000) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const [id, q] of plainQuotes) {
      if (now > q.until) { plainQuotes.delete(id); continue; }
      try {
        const inv = await invoices.get(id);
        if (!inv || inv.status === 'paid') { plainQuotes.delete(id); continue; }
        const paid = await checkPlain(inv);
        if (paid) onPaid?.(paid);
      } catch (e) { console.error('plain watch', id, e.message); }
    }
  }, every);
  timer.unref?.();
  return timer;
}
