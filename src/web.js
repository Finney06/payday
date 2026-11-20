import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { invoices } from './db.js';
import { normalizeAddress, scripthashOf } from './address.js';
import { getRates, toUsdCents } from './rates.js';
import { chain } from './chain.js';
import { quoteBch, submitPayment } from './payments.js';
import { plainQuote, bip21, checkPlain, startPlainWatcher } from './plain.js';
import { renderInvoicePng, renderInvoicePdf } from './invoice-image.js';
import { readFileSync } from 'node:fs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const metaEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Which site sent a visitor, from the browser's referrer: only the site's name, never the full link.
const SOURCES = { 'dorahacks.io': 'DoraHacks', 'x.com': 'X', 't.co': 'X', 'twitter.com': 'X', 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'telegram.org': 'Telegram', 't.me': 'Telegram', 'github.com': 'GitHub', 'linkedin.com': 'LinkedIn' };
export function sourceOf(referrer, ownHost) {
  let host;
  try { host = new URL(String(referrer || '')).hostname.replace(/^www\./, ''); } catch { return ''; }
  if (!host || host === ownHost) return '';
  const known = Object.keys(SOURCES).find((h) => host === h || host.endsWith(`.${h}`));
  return known ? SOURCES[known] : host;
}
const fromText = (src) => (src ? ` (from ${src})` : '');

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

export function createWeb({ getBotUsername, onPaid, onAlert, onActivity }) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.NODE_ENV !== 'test') startPlainWatcher((inv) => onPaid?.(inv));
  app.use(express.json({ limit: '20kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/config', (_req, res) => res.json({
    botUsername: getBotUsername(), network: config.network, pusdCategory: config.pusdCategory,
    repoUrl: config.repoUrl, slidesUrl: config.slidesUrl, emberAddress: config.emberAddress,
    demoCents: config.demoCents,
  }));

  // "Try it": a fresh 5-cent invoice for each visitor (judges), paid to Finney's wallet.
  app.get('/try', async (_req, res) => {
    const addr = normalizeAddress(config.demoAddress);
    if (!addr) return res.status(503).send('Demo is not configured yet.');
    const inv = await invoices.create({
      chatId: config.demoChatId, payeeName: config.demoName, payeeAddress: addr.tokenAddress,
      client: 'You', description: 'Payday demo payment',
      amountCents: config.demoCents, inputAmount: config.demoCents / 100, inputCurrency: 'USD',
    });
    res.redirect(302, `/pay/${inv.id}`);
  });

  app.get('/api/rates', async (_req, res) => {
    try { res.json(await getRates()); } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.get('/api/invoice/:id', async (req, res) => {
    const inv = await invoices.get(req.params.id);
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

    const inv = await invoices.create({
      payeeName: String(name).trim().slice(0, 60), payeeAddress: addr.tokenAddress,
      client: String(client).trim().slice(0, 60), description: String(description || 'Services').trim().slice(0, 120),
      amountCents, inputAmount: value, inputCurrency: currency,
    });
    onActivity?.(`🧾 Someone made an invoice on the website ($${(amountCents / 100).toFixed(2)}).`, `inv:${inv.id}`);
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
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    try {
      const q = await quoteBch(inv);
      res.json({ sats: q.sats, bchUsd: q.bchUsd, expiresAt: q.expiresAt, pusdUnits: inv.amount_cents });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  // Pay with any wallet: a plain BCH QR code with this invoice's exact amount.
  app.get('/api/invoice/:id/plain', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'paid') return res.status(409).json({ error: 'This invoice is already paid.' });
    try {
      const q = await plainQuote(inv);
      res.json({ address: q.address, sats: q.sats, bch: (q.sats / 1e8).toFixed(8), uri: bip21(q), until: q.until });
    } catch (e) { res.status(503).json({ error: e.message }); }
  });

  app.post('/api/invoice/:id/check', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    try {
      const paid = await checkPlain(inv);
      if (paid) onPaid?.(paid);
      res.json(publicInvoice(paid || await invoices.get(inv.id)));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.post('/api/invoice/:id/submit', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const { txHex, method } = req.body || {};
    try {
      const paid = await submitPayment(inv, String(txHex || ''), method === 'PUSD' ? 'PUSD' : 'BCH');
      onPaid?.(paid);
      res.json(publicInvoice(paid));
    } catch (e) {
      console.error('submit failed', inv.id, e.message);
      onAlert?.(`Payment refused by the server\nInvoice: ${inv.id} (${config.baseUrl}/pay/${inv.id})\nMethod: ${method}\nError: ${e.message}`, `submit:${inv.id}:${e.message}`);
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Someone arrived on the home page from another site.
  app.post('/api/visit', (req, res) => {
    const src = sourceOf(req.body?.referrer, req.hostname);
    if (src) onActivity?.(`🏠 Someone opened the Payday website${fromText(src)}.`);
    res.status(204).end();
  });

  // A real browser opened a pay link or the demo. Sent by the page's script, so link-preview robots (X, WhatsApp, Telegram) aren't counted.
  app.post('/api/seen', async (req, res) => {
    const id = String(req.body?.invoiceId || '').slice(0, 20);
    const inv = id ? await invoices.get(id).catch(() => null) : null;
    const demo = inv && inv.chat_id === config.demoChatId && inv.client === 'You';
    const from = fromText(sourceOf(req.body?.referrer, req.hostname));
    if (inv && demo && inv.status !== 'paid') onActivity?.(`👀 Someone opened the 5¢ demo${from}.`, `seen:${inv.id}`);
    else if (inv && !demo) onActivity?.(`👀 Someone opened a pay link (${inv.status === 'paid' ? 'already paid' : 'not paid yet'})${from}.`, `seen:${inv.id}`);
    res.status(204).end();
  });

  // The pay page reports errors a payer hits, so the developer hears about them right away.
  app.post('/api/report', async (req, res) => {
    const b = req.body || {};
    const clip = (v, n = 300) => String(v ?? '').slice(0, n);
    const inv = b.invoiceId ? await invoices.get(clip(b.invoiceId, 20)).catch(() => null) : null;
    if (!inv) return res.status(204).end();
    onAlert?.([
      `A payer hit an error`,
      `Invoice: ${inv.id} (${config.baseUrl}/pay/${inv.id})`,
      `Wallet: ${clip(b.wallet, 60) || 'not connected yet'}`,
      `Method: ${clip(b.method, 10)} · Step: ${clip(b.step, 40)}`,
      `Device: ${clip(b.device, 160)}`,
      `Error: ${clip(b.error, 600)}`,
    ].join('\n'), `report:${inv.id}:${clip(b.error, 120)}`);
    res.status(204).end();
  });

  // Invoice / receipt image (also used as the WhatsApp/Telegram link preview of a pay link).
  const imageCache = new Map(); // `${id}:${status}` -> { png, at }
  app.get('/i/:id.png', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).end();
    const key = `${inv.id}:${inv.status}`;
    let hit = imageCache.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
      try { hit = { png: await renderInvoicePng(inv), at: Date.now() }; } catch (e) { console.error('image', e.message); return res.status(500).end(); }
      if (imageCache.size > 500) imageCache.clear();
      imageCache.set(key, hit);
    }
    res.set('Cache-Control', 'public, max-age=300').type('png').send(hit.png);
  });

  app.get('/i/:id.pdf', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).end();
    try {
      const pdf = await renderInvoicePdf(inv);
      res.set('Content-Disposition', `attachment; filename="Payday-invoice-${inv.id}.pdf"`).type('pdf').send(pdf);
    } catch (e) { console.error('pdf', e.message); res.status(500).end(); }
  });

  // Opens the sender's own email app with the invoice message ready. Payday does not send email.
  app.get('/email/:id', async (req, res) => {
    const inv = await invoices.get(req.params.id);
    if (!inv) return res.status(404).type('text').send('Invoice not found');
    const amount = `$${(inv.amount_cents / 100).toFixed(2)}`, payUrl = `${config.baseUrl}/pay/${inv.id}`, pdfUrl = `${config.baseUrl}/i/${inv.id}.pdf`;
    const subject = `Invoice: ${inv.description} (${amount})`;
    const sign = `Thanks,
${inv.payee_name}`;
    // Phones can attach the PDF through the share sheet; a mailto link can only carry text, so it links the PDF instead.
    const attached = `Hi ${inv.client},

My invoice for ${inv.description} (${amount}) is attached.
You can pay it here: ${payUrl}

${sign}`;
    const linked = `Hi ${inv.client},

Here's my invoice for ${inv.description} (${amount}).
Pay here: ${payUrl}
Invoice PDF: ${pdfUrl}

${sign}`;
    const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(linked)}`;
    const data = JSON.stringify({ id: inv.id, attached, linked }).replace(/</g, '\u003c');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Email invoice · Payday</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"></head><body><header class="topbar"><a class="logo" href="/"><img src="/icon.svg" alt="" width="30" height="30">Payday</a></header><main class="wrap"><article class="ticket"><div class="ticket-body email-draft"><h1>Email this invoice</h1>
<p id="email-note" class="muted">Your email app opens with this message ready. Add ${metaEsc(inv.client)}'s email address, then send.</p>
<pre id="email-text">${metaEsc(linked)}</pre>
<div class="email-actions">
<button id="email-attach" class="btn block hidden" type="button">Email with PDF attached</button>
<a id="email-open" class="btn block" href="${metaEsc(mailto)}">Open email app</a>
<a id="email-pdf" class="btn block secondary" href="/i/${inv.id}.pdf" download="invoice-${inv.id}.pdf">Download PDF</a>
<button id="email-copy" class="btn block secondary" type="button">Copy message</button>
</div></div></article></main>
<script>
const D = ${data};
const $ = (id) => document.getElementById(id);
let pdf = null;
// Phones can attach the PDF through the share sheet. Fetch it ahead of the tap so the sheet opens straight away.
fetch('/i/' + D.id + '.pdf').then((r) => r.blob()).then((b) => {
  const file = new File([b], 'invoice-' + D.id + '.pdf', { type: 'application/pdf' });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return;
  pdf = file;
  $('email-attach').classList.remove('hidden');
  $('email-open').classList.add('hidden');
  $('email-pdf').classList.add('hidden');
  $('email-text').textContent = D.attached;
  $('email-note').textContent = 'Pick your email app. The PDF is attached and the message is written. Add the email address and a subject, then send.';
}).catch(() => {});
$('email-attach').onclick = async () => {
  try { await navigator.share({ files: [pdf], text: D.attached }); } catch (e) { /* closed the share sheet */ }
};
$('email-copy').onclick = async function () {
  try { await navigator.clipboard.writeText($('email-text').textContent); this.textContent = 'Copied ✓'; } catch { this.textContent = 'Select the message to copy it'; }
};
</script></body></html>`);
  });

  // Pay page, with this invoice's own preview image and title for link previews.
  const payHtml = readFileSync(join(publicDir, 'pay.html'), 'utf8');
  app.get('/pay/:id', async (req, res) => {
    const inv = /^[a-z0-9]{4,16}$/.test(req.params.id) ? await invoices.get(req.params.id) : null;
    if (!inv) return res.type('html').send(payHtml);
    const amount = `$${(inv.amount_cents / 100).toFixed(2)}`;
    const title = `${inv.payee_name} sent you an invoice for ${amount}`;
    const desc = `${inv.description}. Pay in seconds with dollars (ParyonUSD) or Bitcoin Cash.`;
    const html = payHtml
      .replace(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${config.baseUrl}/i/${inv.id}.png">`)
      .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${metaEsc(title)}">`)
      .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${metaEsc(desc)}">`)
      .replace('</head>', '  <meta name="twitter:card" content="summary_large_image">\n</head>');
    res.type('html').send(html);
  });
  app.use(express.static(publicDir, { extensions: ['html'] }));

  return app;
}
