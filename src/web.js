import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { invoices } from './db.js';
import { normalizeAddress, scripthashOf } from './address.js';
import { getRates, toUsdCents } from './rates.js';
import { chain } from './chain.js';
import { quoteBch, submitPayment } from './payments.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Only what the client's pay page needs. Never the freelancer's chat id.
function publicInvoice(inv) {
  return {
    id: inv.id,
    payeeName: inv.payee_name,
    payeeAddress: inv.payee_address,
    client: inv.client,
    description: inv.description,
    amountCents: inv.amount_cents,
    inputAmount: inv.input_amount,
    inputCurrency: inv.input_currency,
    status: inv.status,
    txid: inv.txid,
    paidWith: inv.paid_with,
    paidAt: inv.paid_at,
    createdAt: inv.created_at,
  };
}

export function createWeb({ getBotUsername, onPaid }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));

  app.get('/api/config', (_req, res) => res.json({
    botUsername: getBotUsername(), network: config.network, pusdCategory: config.pusdCategory,
    repoUrl: config.repoUrl, slidesUrl: config.slidesUrl, emberAddress: config.emberAddress,
    demoCents: config.demoCents,
  }));

  // "Try it": a fresh 5-cent invoice for each visitor (judges), paid to Finney's wallet.
  app.get('/try', (_req, res) => {
    const addr = normalizeAddress(config.demoAddress);
    if (!addr) return res.status(503).send('Demo is not configured yet.');
    const inv = invoices.create({
      chatId: config.demoChatId, payeeName: config.demoName, payeeAddress: addr.tokenAddress,
      client: 'You', description: 'Payday demo payment',
      amountCents: config.demoCents, inputAmount: config.demoCents / 100, inputCurrency: 'USD',
    });
    res.redirect(302, `/pay/${inv.id}`);
  });

  app.get('/api/rates', async (_req, res) => {
    try { res.json(await getRates()); } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.get('/api/invoice/:id', (req, res) => {
    const inv = invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(publicInvoice(inv));
  });

  // Create an invoice from the website (for people without Telegram).
  app.post('/api/invoices', async (req, res) => {
    const { name, address, client, description, amount, currency = 'USD' } = req.body || {};
    const addr = normalizeAddress(address);
    const value = Number(amount);
    if (!addr) return res.status(400).json({ error: 'That is not a valid Bitcoin Cash address.' });
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Please add your name.' });
    if (!String(client || '').trim()) return res.status(400).json({ error: 'Please add the client\'s name.' });
    if (!['USD', 'GBP', 'NGN'].includes(currency)) return res.status(400).json({ error: 'Unsupported currency.' });
    if (!(value > 0)) return res.status(400).json({ error: 'Please enter an amount.' });
    let amountCents;
    try { amountCents = await toUsdCents(value, currency); } catch (e) { return res.status(503).json({ error: e.message }); }
    if (amountCents < 1 || amountCents > 10_000_00) return res.status(400).json({ error: 'Amount must be between $0.01 and $10,000.' });

    const inv = invoices.create({
      payeeName: String(name).trim().slice(0, 60), payeeAddress: addr.tokenAddress,
      client: String(client).trim().slice(0, 60), description: String(description || 'Services').trim().slice(0, 120),
      amountCents, inputAmount: value, inputCurrency: currency,
    });
    res.status(201).json({ ...publicInvoice(inv), payUrl: `${config.baseUrl}/pay/${inv.id}` });
  });

  // Coins in the payer's wallet (the pay page sends addresses it derived from the wallet's public keys).
  app.post('/api/utxos', async (req, res) => {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses.slice(0, 60) : [];
    if (!addresses.every((a) => normalizeAddress(a))) return res.status(400).json({ error: 'Invalid address list' });
    try {
      const results = await Promise.all(addresses.map((a) => chain.listUnspent(scripthashOf(a))));
      const shape = (u) => ({
        txid: u.tx_hash, vout: u.tx_pos, value: String(u.value), height: u.height,
        token: u.token_data ? { category: u.token_data.category, amount: String(u.token_data.amount ?? '0'), nft: u.token_data.nft ?? null } : null,
      });
      res.json(Object.fromEntries(addresses.map((a, i) => [a, results[i].map(shape)])));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get('/api/invoice/:id/quote', async (req, res) => {
    const inv = invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    try {
      const q = await quoteBch(inv);
      res.json({ sats: q.sats, bchUsd: q.bchUsd, expiresAt: q.expiresAt, pusdUnits: inv.amount_cents });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.post('/api/invoice/:id/submit', async (req, res) => {
    const inv = invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const { txHex, method } = req.body || {};
    try {
      const paid = await submitPayment(inv, String(txHex || ''), method === 'PUSD' ? 'PUSD' : 'BCH');
      onPaid?.(paid);
      res.json(publicInvoice(paid));
    } catch (e) {
      console.error('submit failed', inv.id, e.message);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  app.get('/pay/:id', (_req, res) => res.sendFile(join(publicDir, 'pay.html')));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  return app;
}
