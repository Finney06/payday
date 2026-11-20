import QRCode from 'qrcode';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { WalletSession, loadPairing, forgetPairing } from './wallet.js';

const $ = (id) => document.getElementById(id);
const invoiceId = location.pathname.split('/').pop();

const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, cur) => ({ USD: '$', GBP: '£', NGN: '₦' }[cur]) +
  v.toLocaleString('en-US', { minimumFractionDigits: cur === 'NGN' ? 0 : 2, maximumFractionDigits: cur === 'NGN' ? 0 : 2 });
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let invoice, rates, cfg, method = 'PUSD', session = null, busy = false, lastStep = '';

// ---------- rendering ----------
function renderSendAmount() {
  if (method === 'PUSD') {
    $('send-amount').textContent = `${(invoice.amountCents / 100).toFixed(2)} ParyonUSD`;
  } else {
    const b = rates ? (invoice.amountCents / 100) / rates.bchUsd : null;
    $('send-amount').textContent = b ? `≈ ${b.toFixed(8).replace(/0+$/, '')} BCH` : '… BCH';
  }
}

function render() {
  $('pdf-invoice').href = `/i/${invoiceId}.pdf`;
  document.title = `Pay ${usd(invoice.amountCents)} to ${invoice.payeeName} · Payday`;
  $('payee').textContent = invoice.payeeName;
  $('amount').textContent = usd(invoice.amountCents);
  let sub = '';
  if (invoice.inputCurrency !== 'USD') sub = `${money(invoice.inputAmount, invoice.inputCurrency)} at today's rate`;
  else if (rates) sub = `≈ ${money((invoice.amountCents / 100) * rates.usdNgn, 'NGN')} · ${money((invoice.amountCents / 100) * rates.usdGbp, 'GBP')}`;
  $('amount-sub').textContent = sub;
  $('desc').textContent = invoice.description;
  $('client').textContent = invoice.client;
  $('inv-id').textContent = invoice.id;
  $('date').textContent = new Date(invoice.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const paid = invoice.status === 'paid';
  $('status').className = `pill ${paid ? 'paid' : 'unpaid'}`;
  $('status').textContent = paid ? 'Paid' : 'Unpaid';
  $('pay-box').classList.toggle('hidden', paid);
  $('paid-box').classList.toggle('hidden', !paid);
  if (paid) {
    $('paid-line').textContent = `${usd(invoice.amountCents)} paid in ${invoice.paidWith === 'PUSD' ? 'ParyonUSD' : 'BCH'} · ${new Date(invoice.paidAt).toLocaleString()}`;
    $('proof').href = `https://explorer.bch.ninja/tx/${invoice.txid}`;
  } else {
    renderSendAmount();
  }
}

function setStep(step, message = '') {
  // step: idle | pairing | working | error
  if (step !== 'error') lastStep = message || step;
  $('alt-btn').classList.add('hidden');
  $('pay-btn').classList.toggle('hidden', step !== 'idle' && step !== 'error');
  $('pay-btn').textContent = step === 'error' ? 'Try again' : 'Connect wallet & pay';
  $('plain-btn').classList.toggle('hidden', step !== 'idle' && step !== 'error');
  $('wallet-panel').classList.toggle('hidden', step !== 'pairing' && step !== 'working');
  $('qr-wrap').classList.toggle('hidden', step !== 'pairing');
  $('cancel-btn').classList.toggle('hidden', step !== 'pairing' && step !== 'working');
  $('seg').querySelectorAll('button').forEach((b) => { b.disabled = step === 'pairing' || step === 'working'; });
  const msg = $('pay-msg');
  msg.textContent = message;
  msg.className = `center small ${step === 'error' ? 'error' : 'muted'}`;
}

// ---------- paying ----------
function resumeSignature(approveMessage) {
  setStep('working', approveMessage);
  return session.waitForSignature();
}

async function requestSignature(walletName, approveMessage) {
  setStep('working', `Connected to ${walletName} ✓ Checking your balance…`);
  const utxos = await session.scan();
  const payee = cashAddressToLockingBytecode(invoice.payeeAddress);
  if (typeof payee === 'string') throw new Error('This invoice has an invalid payment address.');

  const q = await (await fetch(`/api/invoice/${invoiceId}/quote`)).json();
  if (!q.sats) throw new Error(q.error || 'Could not get the BCH price.');
  const amountSats = BigInt(q.sats);

  // Does the wallet have enough of the chosen currency? If not, offer the other one.
  const FEE_ROOM = 3000n; // generous room for network fee + token dust
  const pusdHave = utxos.filter((u) => u.token?.category === cfg.pusdCategory && !u.token.nft).reduce((s, u) => s + u.token.amount, 0n);
  const bchHave = utxos.filter((u) => !u.token).reduce((s, u) => s + u.value, 0n);
  const canPusd = pusdHave >= BigInt(invoice.amountCents) && bchHave >= FEE_ROOM;
  const canBch = bchHave >= amountSats + FEE_ROOM;
  const bchText = `${(Number(amountSats) / 1e8).toFixed(8).replace(/0+$/, '')} BCH`;
  if (method === 'PUSD' && !canPusd && canBch) {
    await offerSwitch(`Your wallet doesn't have enough ParyonUSD, but it has BCH.`, `Pay ${bchText} instead`);
    selectMethod('BCH');
  } else if (method === 'BCH' && !canBch && canPusd) {
    await offerSwitch(`Your wallet doesn't have enough BCH, but it has ParyonUSD.`, `Pay ${(invoice.amountCents / 100).toFixed(2)} ParyonUSD instead`);
    selectMethod('PUSD');
  } else if (!canPusd && !canBch) {
    throw new Error(bchHave === 0n && pusdHave === 0n
      ? `This wallet is empty. Add a little BCH (about ${bchText}) or ParyonUSD and try again.`
      : `Not enough funds: this invoice needs ${(invoice.amountCents / 100).toFixed(2)} ParyonUSD or about ${bchText} (plus a tiny network fee).`);
  }
  setStep('working', approveMessage);
  return session.signPayment({
    utxos, method,
    payeeLockingBytecode: payee.bytecode,
    amountSats,
    tokenAmount: BigInt(invoice.amountCents),
    tokenCategory: cfg.pusdCategory,
    invoiceId,
    prompt: `Pay ${usd(invoice.amountCents)} to ${invoice.payeeName} for ${invoice.description}`,
  });
}

async function startPayment() {
  if (busy) return;
  busy = true;
  try {
    session = new WalletSession({
      prefix: cfg.network === 'mainnet' ? 'bitcoincash' : 'bchtest',
      invoiceId,
      method,
      onDisconnect: () => { if (busy) fail(new Error('The wallet disconnected. Please try again.')); },
    });
    // Highest error correction, so the code still scans with the WizardConnect logo over its centre.
    const qrSvg = await QRCode.toString(session.qrUri, { type: 'svg', margin: 1, errorCorrectionLevel: 'H' });
    $('qr').innerHTML = `${qrSvg}<img class="qr-logo" src="/wizardconnect-logo.png" alt="">`;
    $('open-wallet').href = session.uri;
    $('open-wallet').classList.toggle('hidden', !isMobile);
    $('copy-link').classList.remove('hidden');
    $('copy-link').textContent = session.linkCopied ? 'Link copied ✓' : 'Copy wallet link';
    $('qr-wrap').classList.toggle('on-phone', isMobile);
    if (isMobile) $('qr-help').textContent = 'On this phone: copy the link, then in Paytaca open Apps → WizardConnect → Paste URL → Connect. Come back here after connecting.';
    const waiting = session.resumed ? 'Reconnecting to your wallet…' : 'Waiting for your wallet to connect…';
    setStep('pairing', isMobile || session.resumed ? waiting : 'Scan with Paytaca, Selene or any WizardConnect wallet.');

    const walletName = await session.waitForWallet();
    connectedWallet = walletName;
    if (!busy) return;
    const approveMessage = isMobile ? `Open ${walletName} and approve the payment, then come back here.` : `Confirm the payment in ${walletName}…`;
    const signedHex = session.hasPendingSignature
      ? await resumeSignature(approveMessage)
      : await requestSignature(walletName, approveMessage);

    setStep('working', 'Sending payment…');
    const res = await fetch(`/api/invoice/${invoiceId}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHex: signedHex, method }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The payment could not be sent.');
    invoice = data;
    busy = false;
    session.close();
    render();
  } catch (e) {
    fail(e);
  }
}

function selectMethod(m) {
  method = m;
  document.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.method === m)));
  renderSendAmount();
}

// Pauses the payment and shows one button to continue with the other currency.
let resolveSwitch = null;
function offerSwitch(message, label) {
  setStep('working', message);
  $('wallet-panel').classList.add('hidden');
  $('alt-btn').textContent = label;
  $('alt-btn').classList.remove('hidden');
  return new Promise((resolve) => { resolveSwitch = resolve; });
}
$('alt-btn').addEventListener('click', () => {
  $('alt-btn').classList.add('hidden');
  $('wallet-panel').classList.remove('hidden');
  resolveSwitch?.(); resolveSwitch = null;
});

// Sends the error to Payday so the developer gets an alert. Never blocks or breaks the page.
let connectedWallet = '';
function report(e, cancelled) {
  if (cancelled) return;
  try {
    const body = JSON.stringify({
      invoiceId, method, wallet: connectedWallet, step: lastStep,
      error: e?.message || String(e), device: `${isMobile ? 'phone' : 'computer'} · ${navigator.userAgent}`,
    });
    fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* reporting is best effort */ }
}

function fail(e) {
  console.error(e);
  busy = false;
  const cancelled = /reject|cancel|denied|declin/i.test(e.message);
  report(e, cancelled);
  const msg = cancelled ? 'Payment cancelled in the wallet. Nothing was sent.' : e.message;
  setStep('error', msg);
  session?.close();
  session = null;
}

function cancel() {
  busy = false;
  resolveSwitch = null;
  $('alt-btn').classList.add('hidden');
  session?.close();
  session = null;
  setStep('idle', 'Works with Paytaca, Selene and other WizardConnect wallets.');
}

// ---------- pay with any wallet (plain BCH QR) ----------
let plainTimer = null, plainInfo = null;
function showPlain(on) {
  $('plain-panel').classList.toggle('hidden', !on);
  for (const id of ['pay-btn', 'plain-btn', 'pay-msg']) $(id).classList.toggle('hidden', on);
  $('send-amount').parentElement.classList.toggle('hidden', on);
  $('seg').querySelectorAll('button').forEach((b) => { b.disabled = on; });
}
function stopPlain() {
  clearInterval(plainTimer);
  plainTimer = null;
}
async function copyText(text, btn, label) {
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied ✓'; } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = label; }, 1800);
}
async function startPlain() {
  if (busy) return;
  selectMethod('BCH');
  showPlain(true);
  $('plain-msg').textContent = 'Getting the exact amount…';
  try {
    const r = await fetch(`/api/invoice/${invoiceId}/plain`);
    const p = await r.json();
    if (!r.ok) throw new Error(p.error || 'Could not get the BCH amount. Please try again.');
    plainInfo = p;
    const uri = p.uri.startsWith('bitcoincash:') || p.uri.startsWith('bchtest:') ? p.uri : `bitcoincash:${p.uri}`;
    $('plain-qr').innerHTML = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    $('plain-amount').textContent = `${p.bch.replace(/0+$/, '').replace(/.$/, '')} BCH`;
    $('plain-address').textContent = p.address;
    $('plain-open').href = uri;
    $('plain-msg').textContent = 'Waiting for your payment… This page updates by itself.';
    stopPlain();
    plainTimer = setInterval(checkPlainNow, 4000);
  } catch (e) {
    report(e, false);
    $('plain-msg').textContent = e.message;
  }
}
async function checkPlainNow() {
  try {
    const r = await fetch(`/api/invoice/${invoiceId}/check`, { method: 'POST' });
    if (!r.ok) return;
    const fresh = await r.json();
    if (fresh.status === 'paid') { stopPlain(); showPlain(false); invoice = fresh; render(); }
  } catch { /* offline for a moment: keep waiting */ }
}
$('plain-btn').addEventListener('click', startPlain);

// ---------- share the receipt (image or PDF) ----------
$('share-receipt').addEventListener('click', () => {
  const open = $('share-options').classList.toggle('hidden') === false;
  $('share-receipt').setAttribute('aria-expanded', String(open));
});
// Phones open the share sheet (WhatsApp, email…); elsewhere the file downloads.
async function shareReceipt(kind, btn) {
  const url = kind === 'pdf' ? `/i/${invoiceId}.pdf` : `/i/${invoiceId}.png`;
  const name = `payday-receipt-${invoiceId}.${kind}`;
  const label = btn.textContent;
  btn.textContent = 'Preparing…';
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name, { type: kind === 'pdf' ? 'application/pdf' : 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Payment receipt', text: `Receipt for ${invoice.description}, paid with Payday` });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  } catch (e) {
    if (e?.name !== 'AbortError') { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
  } finally {
    btn.textContent = label;
  }
}
$('share-png').addEventListener('click', (e) => shareReceipt('png', e.currentTarget));
$('share-pdf').addEventListener('click', (e) => shareReceipt('pdf', e.currentTarget));
$('plain-back').addEventListener('click', () => { stopPlain(); showPlain(false); setStep('idle', 'Works with Paytaca, Selene and other WizardConnect wallets.'); });
$('plain-copy-amount').addEventListener('click', (e) => plainInfo && copyText(plainInfo.bch.replace(/0+$/, '').replace(/.$/, ''), e.currentTarget, 'Copy amount'));
$('plain-copy-address').addEventListener('click', (e) => plainInfo && copyText(plainInfo.address, e.currentTarget, 'Copy address'));

// ---------- events ----------
document.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => {
  method = b.dataset.method;
  document.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderSendAmount();
}));
$('pay-btn').addEventListener('click', startPayment);
async function copyWalletLink() {
  if (!session) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(session.uri);
    copied = true;
  } catch {
    const box = document.createElement('textarea');
    box.value = session.uri;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    try { copied = document.execCommand('copy'); } catch { /* handled below */ }
    box.remove();
  }
  if (copied) session.markCopied();
  $('copy-link').textContent = copied ? 'Link copied ✓' : 'Copy failed: scan the code instead';
}
$('copy-link').addEventListener('click', copyWalletLink);
$('qr').addEventListener('click', copyWalletLink);
$('cancel-btn').addEventListener('click', cancel);

// If it gets paid from another device, update this page too.
setInterval(async () => {
  if (!invoice || invoice.status === 'paid' || busy) return;
  try {
    const r = await fetch(`/api/invoice/${invoiceId}`);
    if (r.ok) { const fresh = await r.json(); if (fresh.status === 'paid') { invoice = fresh; render(); } }
  } catch { /* offline: ignore */ }
}, 10000);

async function load() {
  const [invRes, cfgRes] = await Promise.all([fetch(`/api/invoice/${encodeURIComponent(invoiceId)}`), fetch('/api/config')]);
  cfg = await cfgRes.json();
  $('loading').classList.add('hidden');
  if (!invRes.ok) { $('notfound').classList.remove('hidden'); return; }
  invoice = await invRes.json();
  fetch('/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceId, referrer: document.referrer }) }).catch(() => {});
  $('invoice').classList.remove('hidden');
  render();
  // A phone may have reloaded this page while the payer was in their wallet: carry on where they left off.
  const pairing = loadPairing(invoiceId);
  if (pairing && invoice.status === 'paid') forgetPairing(invoiceId);
  else if (pairing) {
    if (pairing.method) selectMethod(pairing.method);
    startPayment();
  }
  try { rates = await (await fetch('/api/rates')).json(); render(); } catch { /* optional */ }
}
load();
