// Checks a signed payment really pays the invoice, then sends it to the network.
import { decodeTransaction, hexToBin, binToHex, hashTransaction } from '@bitauth/libauth';
import { config } from './config.js';
import { invoices } from './db.js';
import { normalizeAddress } from './address.js';
import { getRates } from './rates.js';
import { chain } from './chain.js';
import { opReturnInvoice } from '../shared/tx.js';

const QUOTE_TTL = 20 * 60 * 1000;
const quotes = new Map(); // invoiceId -> { sats, at }

// How many satoshis a BCH payment must be, locked for 20 minutes.
export async function quoteBch(inv) {
  const q = quotes.get(inv.id);
  if (q && Date.now() - q.at < QUOTE_TTL) return q;
  const { bchUsd } = await getRates();
  const sats = Math.ceil((inv.amount_cents / 100 / bchUsd) * 1e8);
  const fresh = { sats, bchUsd, at: Date.now(), expiresAt: Date.now() + QUOTE_TTL };
  quotes.set(inv.id, fresh);
  return fresh;
}

export class SubmitError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function submitPayment(inv, txHex, method) {
  if (inv.status === 'paid') throw new SubmitError('This invoice is already paid.', 409);
  if (!/^[0-9a-f]+$/i.test(txHex) || txHex.length > 200_000) throw new SubmitError('Invalid transaction.');

  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') throw new SubmitError('Could not read the transaction.');
  const payee = normalizeAddress(inv.payee_address);
  const payeeHex = payee.lockingBytecodeHex;
  const outputs = tx.outputs.map((o) => ({
    lockingHex: binToHex(o.lockingBytecode),
    sats: o.valueSatoshis,
    token: o.token ? { category: binToHex(o.token.category), amount: o.token.amount } : null,
  }));

  let paidWith;
  if (method === 'PUSD') {
    const paid = outputs.filter((o) => o.lockingHex === payeeHex && o.token?.category === config.pusdCategory)
      .reduce((s, o) => s + o.token.amount, 0n);
    if (paid < BigInt(inv.amount_cents)) throw new SubmitError('This payment is less than the invoice amount.');
    paidWith = 'PUSD';
  } else {
    const q = quotes.get(inv.id) ?? await quoteBch(inv);
    const minSats = BigInt(Math.floor(q.sats * 0.99)); // 1% leeway for rounding
    const paid = outputs.filter((o) => o.lockingHex === payeeHex).reduce((s, o) => s + o.sats, 0n);
    if (paid < minSats) throw new SubmitError('This payment is less than the invoice amount.');
    paidWith = 'BCH';
  }
  const tag = binToHex(opReturnInvoice(inv.id));
  if (!outputs.some((o) => o.lockingHex === tag)) throw new SubmitError('This payment is not linked to this invoice.');

  const txid = hashTransaction(hexToBin(txHex));
  if (await invoices.txidUsed(txid)) throw new SubmitError('This payment was already used.', 409);

  try {
    await chain.broadcast(txHex);
  } catch (e) {
    // Already sent (e.g. the wallet broadcast it too) is fine.
    if (!/already|txn-already-known|in block chain/i.test(e.message)) {
      throw new SubmitError(`The network rejected the payment: ${e.message}`, 502);
    }
  }
  await invoices.markPaid(inv.id, txid, paidWith);
  quotes.delete(inv.id);
  return await invoices.get(inv.id);
}
