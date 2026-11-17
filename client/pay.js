import QRCode from 'qrcode';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { WalletSession } from './wallet.js';

const $ = (id) => document.getElementById(id);
const invoiceId = location.pathname.split('/').pop();

const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, cur) => ({ USD: '$', GBP: '£', NGN: '₦' }[cur]) +
  v.toLocaleString('en-US', { minimumFractionDigits: cur === 'NGN' ? 0 : 2, maximumFractionDigits: cur === 'NGN' ? 0 : 2 });
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let invoice, rates, cfg, method = 'PUSD', session = null, busy = false;

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
  $('status').textContent = paid ? '✅ Paid' : '⏳ Unpaid';
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
  $('alt-btn').classList.add('hidden');
  $('pay-btn').classList.toggle('hidden', step !== 'idle' && step !== 'error');
  $('pay-btn').textContent = step === 'error' ? 'Try again' : 'Connect wallet & pay';
  $('wallet-panel').classList.toggle('hidden', step !== 'pairing' && step !== 'working');
  $('qr-wrap').classList.toggle('hidden', step !== 'pairing');
  $('cancel-btn').classList.toggle('hidden', step !== 'pairing' && step !== 'working');
  $('seg').querySelectorAll('button').forEach((b) => { b.disabled = step === 'pairing' || step === 'working'; });
  const msg = $('pay-msg');
  msg.textContent = message;
  msg.className = `center small ${step === 'error' ? 'error' : 'muted'}`;
}

// ---------- paying ----------
async function startPayment() {
  if (busy) return;
  busy = true;
  try {
    session = new WalletSession({
      prefix: cfg.network === 'mainnet' ? 'bitcoincash' : 'bchtest',
      onDisconnect: () => { if (busy) fail(new Error('The wallet disconnected. Please try again.')); },
    });
    $('qr').innerHTML = await QRCode.toString(session.qrUri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    $('open-wallet').href = session.uri;
    $('open-wallet').classList.toggle('hidden', !isMobile);
    setStep('pairing', isMobile ? 'Tap "Open wallet app", or scan the code from another phone.' : 'Scan with Paytaca (or any WizardConnect wallet).');

    const walletName = await session.waitForWallet();
    if (!busy) return;
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
    setStep('working', `Confirm the payment in ${walletName}…`);
    const signedHex = await session.signPayment({
      utxos, method,
      payeeLockingBytecode: payee.bytecode,
      amountSats,
      tokenAmount: BigInt(invoice.amountCents),
      tokenCategory: cfg.pusdCategory,
      invoiceId,
      prompt: `Pay ${usd(invoice.amountCents)} to ${invoice.payeeName} for ${invoice.description}`,
    });

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

function fail(e) {
  console.error(e);
  busy = false;
  const msg = /reject|cancel|denied|declin/i.test(e.message) ? 'Payment cancelled in the wallet. Nothing was sent.' : e.message;
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
  setStep('idle', 'Works with Paytaca and other WizardConnect wallets.');
}

// ---------- events ----------
document.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => {
  method = b.dataset.method;
  document.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderSendAmount();
}));
$('pay-btn').addEventListener('click', startPayment);
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
  $('invoice').classList.remove('hidden');
  render();
  try { rates = await (await fetch('/api/rates')).json(); render(); } catch { /* optional */ }
}
load();
