import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { invoices } from './db.js';
import { normalizeAddress } from './address.js';
import { getRates, toUsdCents } from './rates.js';

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

export function createWeb({ getBotUsername }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));

  app.get('/api/config', (_req, res) => res.json({
    botUsername: getBotUsername(), network: config.network, pusdCategory: config.pusdCategory,
  }));

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

  app.get('/pay/:id', (_req, res) => res.sendFile(join(publicDir, 'pay.html')));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  return app;
}
