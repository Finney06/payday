// Home page behaviour: hackathon banner, invoice form with live preview, rate check.
(() => {
  const $ = (id) => document.getElementById(id);
  const SYMBOL = { USD: '$', GBP: '£', NGN: '₦' };
  const money = (v, cur) => {
    const d = cur === 'NGN' ? 0 : 2;
    return SYMBOL[cur] + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const bch = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 4 : v >= 0.01 ? 6 : 8 }) + ' BCH';
  // Everything is priced through dollars. rates = { bchUsd, usdGbp, usdNgn }.
  const toUsd = (v, cur, r) => (cur === 'USD' ? v : cur === 'GBP' ? v / r.usdGbp : v / r.usdNgn);

  let rates = null;

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      t.remove();
    }
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1600);
  }

  // The mock chat and step 2 show the real host name.
  document.querySelectorAll('.host').forEach((el) => { el.textContent = location.host; });
  // ---------- phone: the Telegram flow, played on a loop ----------
  const chat = $('tg-chat');
  if (chat) {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const field = $('tg-field');
    const sub = $('tg-sub');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const add = (cls, html) => {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = html;
      el.querySelectorAll('.host').forEach((h) => { h.textContent = location.host; });
      chat.append(el);
      return el;
    };
    const LINE = 'invoice Sarah $50 logo design';
    const PHOTO = '<div class="tg-photo-wrap"><img class="tg-photo" src="/demo-invoice.png" alt="" width="200" height="250"></div>';
    const STAMP = '<span class="tg-paid-pill">PAID</span><span class="tg-stamp">PAID</span>';
    const INVOICE = PHOTO +
      '<div class="tg-cap"><b>Invoice k7m2xq9d</b><br>Send this to Sarah 👇<br>' +
      '<span class="tg-link"><span class="host"></span><br>/pay/k7m2xq9d</span><span class="tg-time">12:04</span></div>';
    const PAID = '🎉 <b>Sarah paid $50.00</b> in ParyonUSD.<br>The money is already in your wallet.<span class="tg-time">12:06</span>';

    async function botTyping(ms) {
      sub.textContent = 'typing…';
      sub.classList.add('typing');
      const dots = add('tg-dots', '<i></i><i></i><i></i>');
      await sleep(ms);
      dots.remove();
      sub.textContent = 'bot';
      sub.classList.remove('typing');
    }

    const stampInvoice = () => chat.querySelector('.tg-photo-wrap')?.insertAdjacentHTML('beforeend', STAMP);

    // The first thing a visitor sees: one message became a paid invoice.
    function showPaidChat() {
      chat.replaceChildren();
      add('tg-msg out', `${LINE}<span class="tg-time">12:04 ✓✓</span>`);
      add('tg-msg in tg-media', PHOTO);
      stampInvoice();
      add('tg-msg in', PAID);
    }

    async function play() {
      showPaidChat();
      await sleep(4200);
      chat.classList.add('fade');
      await sleep(400);
      for (;;) {
        chat.replaceChildren();
        chat.classList.remove('fade');
        await sleep(700);
        // The freelancer types one line and sends it.
        field.classList.add('filled');
        for (let i = 1; i <= LINE.length; i++) { field.textContent = LINE.slice(0, i); await sleep(55); }
        await sleep(450);
        field.classList.remove('filled');
        field.textContent = 'Message';
        add('tg-msg out', `${LINE}<span class="tg-time">12:04 ✓✓</span>`);
        await sleep(500);
        // The bot replies with the invoice and share buttons.
        await botTyping(1100);
        add('tg-msg in tg-media', INVOICE);
        const kb = add('tg-kb', '<span>📲 WhatsApp</span><span>✈️ Telegram</span>');
        await sleep(1700);
        kb.firstElementChild.classList.add('pressed');
        await sleep(450);
        kb.firstElementChild.classList.remove('pressed');
        // A little later, the client pays.
        await sleep(1600);
        await botTyping(900);
        add('tg-msg in', PAID);
        stampInvoice();
        await sleep(4200);
        chat.classList.add('fade');
        await sleep(400);
      }
    }
    if (reduceMotion) showPaidChat();
    else play();
  }

  // ---------- hackathon banner + demo amount (from /api/config) ----------
  async function loadConfig() {
    let cfg;
    try { cfg = await (await fetch('/api/config')).json(); } catch { return; }
    if (cfg.slidesUrl) {
      const a = $('slides-link');
      // The deck lives at /slides/ on this site; a slidesUrl from the server overrides it.
      a.href = cfg.slidesUrl;
    }
    if (cfg.repoUrl) $('repo-link').href = cfg.repoUrl;
    if (cfg.emberAddress) {
      $('ember-address').textContent = cfg.emberAddress;
      $('ember-address').title = cfg.emberAddress;
      $('ember-row').classList.remove('hidden');
    }
    if (cfg.demoCents) {
      $('demo-amount').textContent = cfg.demoCents < 100 ? `${cfg.demoCents}¢` : money(cfg.demoCents / 100, 'USD');
    }
  }
  $('slides-link').addEventListener('click', (e) => { if (e.currentTarget.getAttribute('aria-disabled')) e.preventDefault(); });
  $('ember-copy').addEventListener('click', (e) => copyText($('ember-address').textContent, e.currentTarget));

  // ---------- invoice form + live preview ----------
  const form = $('invoice-form');
  const f = { name: $('f-name'), client: $('f-client'), desc: $('f-desc'), amount: $('f-amount'), currency: $('f-currency'), address: $('f-address') };

  function renderPreview() {
    const cur = f.currency.value;
    const v = parseFloat(f.amount.value);
    const ok = v > 0;
    $('p-name').textContent = f.name.value.trim() || 'Your name';
    $('p-client').textContent = f.client.value.trim() || 'Your client';
    $('p-desc').textContent = f.desc.value.trim() || 'Services';
    let usd = null;
    if (ok) usd = cur === 'USD' ? v : rates ? toUsd(v, cur, rates) : null;
    $('p-amount').textContent = usd === null ? (ok ? money(v, cur) : '$0.00') : money(usd, 'USD');
    $('p-sub').textContent = ok && cur !== 'USD' && usd !== null ? `${money(v, cur)} at today's rate` : '';
    $('f-amount-hint').textContent = ok && cur !== 'USD' && usd !== null
      ? `Your client pays ${money(usd, 'USD')}, the dollar value today.`
      : 'Your client always pays the dollar value.';
  }
  Object.values(f).forEach((el) => el.addEventListener('input', () => { if ($('p-result').classList.contains('hidden')) renderPreview(); }));

  // Remember who you are on this device, so the next invoice is quicker.
  try {
    f.name.value = localStorage.getItem('payday.name') || '';
    f.address.value = localStorage.getItem('payday.address') || '';
  } catch { /* private mode: fine */ }

  function showError(message, field) {
    $('form-error').textContent = message;
    if (field) field.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('form-error').textContent = '';
    const body = {
      name: f.name.value.trim(), client: f.client.value.trim(), description: f.desc.value.trim() || 'Services',
      amount: parseFloat(f.amount.value), currency: f.currency.value, address: f.address.value.trim(),
    };
    if (!body.name) return showError('Please add your name.', f.name);
    if (!body.client) return showError("Please add the client's name.", f.client);
    if (!(body.amount > 0)) return showError('Please enter an amount.', f.amount);
    if (!body.address) return showError('Please paste your Bitcoin Cash address.', f.address);

    const btn = $('form-submit');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.payUrl) throw new Error(data.error || 'Could not create the invoice. Please try again.');
      try { localStorage.setItem('payday.name', body.name); localStorage.setItem('payday.address', body.address); } catch { /* fine */ }
      showResult(data);
    } catch (err) {
      showError(err instanceof TypeError ? 'No connection. Check your internet and try again.' : err.message,
        /address/i.test(err.message) ? f.address : null);
    } finally {
      btn.disabled = false; btn.textContent = 'Create pay link';
    }
  });

  function showResult(inv) {
    const usd = money(inv.amountCents / 100, 'USD');
    $('p-name').textContent = inv.payeeName;
    $('p-client').textContent = inv.client;
    $('p-desc').textContent = inv.description;
    $('p-amount').textContent = usd;
    $('p-sub').textContent = inv.inputCurrency !== 'USD' ? `${money(inv.inputAmount, inv.inputCurrency)} at today's rate` : '';
    $('p-status').className = 'pill unpaid';
    $('p-status').textContent = 'Unpaid';
    $('result-link').href = inv.payUrl;
    $('result-link').textContent = inv.payUrl.replace(/^https?:\/\//, '');
    // Same wording the bot uses.
    const text = `Hi ${inv.client}, here's my invoice for ${inv.description}: ${usd}.\n` +
      `You can pay in seconds with dollars (ParyonUSD) or Bitcoin Cash here: ${inv.payUrl}`;
    $('result-wa').href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    $('result-email').href = `/email/${inv.id}`;
    $('result-pdf').href = `/i/${inv.id}.pdf`;
    $('result-copy').onclick = (e) => copyText(inv.payUrl, e.currentTarget);
    $('p-empty').classList.add('hidden');
    $('p-result').classList.remove('hidden');
    $('preview').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    $('preview').focus({ preventScroll: true });
  }

  $('result-again').addEventListener('click', () => {
    f.client.value = ''; f.desc.value = ''; f.amount.value = '';
    $('p-result').classList.add('hidden');
    $('p-empty').classList.remove('hidden');
    $('p-status').className = 'pill draft';
    $('p-status').textContent = 'Preview';
    renderPreview();
    f.client.focus();
  });

  // ---------- rate check ----------
  const NAMES = { USD: 'US dollars', GBP: 'British pounds', NGN: 'Nigerian naira' };
  let rcCur = 'USD';

  function renderRates() {
    $('rc-symbol').textContent = SYMBOL[rcCur];
    const out = $('rc-out');
    const v = parseFloat($('rc-amount').value);    const others = ['NGN', 'USD', 'GBP'].filter((c) => c !== rcCur);
    const row = (label, value) => {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.className = 'cur'; a.textContent = label;
      const b = document.createElement('span'); b.className = 'val'; b.textContent = value;
      li.append(a, b);
      return li;
    };
    const blank = !rates || !(v >= 0);
    const usd = blank ? 0 : toUsd(v, rcCur, rates);
    const inCur = (c) => (c === 'USD' ? usd : c === 'GBP' ? usd * rates.usdGbp : usd * rates.usdNgn);
    out.replaceChildren(
      ...others.map((c) => row(NAMES[c], blank ? '…' : money(inCur(c), c))),
      row('Bitcoin Cash', blank ? '…' : bch(usd / rates.bchUsd)),
    );
    if (rates) {
      const time = rates.at ? new Date(rates.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
      $('rc-note').textContent = `Live rates: $1 = ${money(rates.usdNgn, 'NGN')}, 1 BCH = ${money(rates.bchUsd, 'USD')}.` + (time ? ` Updated ${time}.` : '');
    }
  }
  $('rc-amount').addEventListener('input', renderRates);
  $('rc-cur').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    rcCur = b.dataset.cur;
    $('rc-cur').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderRates();
  }));

  async function loadRates() {
    try {
      const res = await fetch('/api/rates');
      if (!res.ok) throw new Error('rates unavailable');
      rates = await res.json();
    } catch {
      rates = null;
      $('rc-note').textContent = "Couldn't load today's rates. Check your connection and reload.";
    }
    renderRates();
    // Hero tile: $50 in naira at the live rate.
    if (rates && $('hero-ngn')) $('hero-ngn').textContent = money(50 * rates.usdNgn, 'NGN');
    if ($('p-result').classList.contains('hidden')) renderPreview();
  }

  renderPreview();
  loadConfig();
  loadRates();
})();
