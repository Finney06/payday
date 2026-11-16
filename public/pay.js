const $ = (id) => document.getElementById(id);
const id = location.pathname.split('/').pop();

const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, cur) => ({ USD: '$', GBP: '£', NGN: '₦' }[cur]) +
  v.toLocaleString('en-US', { minimumFractionDigits: cur === 'NGN' ? 0 : 2, maximumFractionDigits: cur === 'NGN' ? 0 : 2 });

let invoice, rates, method = 'PUSD';

function bchAmount() {
  if (!rates) return null;
  return (invoice.amountCents / 100) / rates.bchUsd;
}

function renderSendAmount() {
  if (method === 'PUSD') {
    $('send-amount').textContent = `${(invoice.amountCents / 100).toFixed(2)} ParyonUSD`;
  } else {
    const b = bchAmount();
    $('send-amount').textContent = b ? `${b.toFixed(8).replace(/0+$/, '')} BCH` : '… BCH';
  }
}

function render() {
  document.title = `Pay ${usd(invoice.amountCents)} to ${invoice.payeeName} · Payday`;
  $('payee').textContent = invoice.payeeName;
  $('amount').textContent = usd(invoice.amountCents);
  const subs = [];
  if (invoice.inputCurrency !== 'USD') subs.push(`${money(invoice.inputAmount, invoice.inputCurrency)} at today's rate`);
  else if (rates) subs.push(`≈ ${money((invoice.amountCents / 100) * rates.usdNgn, 'NGN')} · ${money((invoice.amountCents / 100) * rates.usdGbp, 'GBP')}`);
  $('amount-sub').textContent = subs.join('');
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
    $('paid-line').textContent = `${usd(invoice.amountCents)} paid in ${invoice.paidWith === 'PUSD' ? 'ParyonUSD' : 'BCH'} on ${new Date(invoice.paidAt).toLocaleString()}`;
    $('proof').href = `https://explorer.bch.ninja/tx/${invoice.txid}`;
  } else {
    renderSendAmount();
  }
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  method = b.dataset.method;
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderSendAmount();
}));

$('pay-btn').addEventListener('click', () => {
  // Wallet connection (WizardConnect) is wired in next.
  $('pay-msg').textContent = 'Wallet payments are being switched on. Check back shortly.';
});

async function load() {
  const res = await fetch(`/api/invoice/${encodeURIComponent(id)}`);
  $('loading').classList.add('hidden');
  if (!res.ok) { $('notfound').classList.remove('hidden'); return; }
  invoice = await res.json();
  $('invoice').classList.remove('hidden');
  render();
  try { rates = await (await fetch('/api/rates')).json(); render(); } catch { /* rates are optional for display */ }
}
load();
