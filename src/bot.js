import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { freelancers, invoices } from './db.js';
import { normalizeAddress, shortAddress } from './address.js';
import { parseInvoiceLine, parseAmount } from './parse.js';
import { toUsdCents, fmt } from './rates.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const payLink = (inv) => `${config.baseUrl}/pay/${inv.id}`;

// What each chat is in the middle of (address setup or the 3-question flow).
const state = new Map();

function amountLine(inv) {
  const usd = fmt.usd(inv.amount_cents);
  return inv.input_currency === 'USD' ? usd : `${usd} (${fmt.input(inv.input_amount, inv.input_currency)})`;
}

export function clientMessage(inv) {
  return `Hi ${inv.client}, here's my invoice for ${inv.description}: ${fmt.usd(inv.amount_cents)}.\n` +
    `You can pay in seconds with dollars (ParyonUSD) or Bitcoin Cash here: ${payLink(inv)}`;
}

export function reminderMessage(inv) {
  return `Hi ${inv.client}, just a gentle reminder about my invoice for ${inv.description} ` +
    `(${fmt.usd(inv.amount_cents)}). Here's the pay link again: ${payLink(inv)}\nThank you!`;
}

function shareKeyboard(inv, text) {
  const kb = new InlineKeyboard()
    .url('📲 Send on WhatsApp', `https://wa.me/?text=${encodeURIComponent(text)}`).row()
    .url('✈️ Share on Telegram', `https://t.me/share/url?url=${encodeURIComponent(payLink(inv))}&text=${encodeURIComponent(text.split('\n')[0])}`);
  // Telegram only accepts public URLs on buttons (not localhost).
  if (/^https:\/\//.test(config.baseUrl)) kb.row().url('👀 Open pay page', payLink(inv));
  return kb;
}

// Send with buttons; if Telegram rejects the buttons for any reason, still send the text.
async function replyWithButtons(ctx, html, keyboard) {
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  try {
    return await ctx.reply(html, { ...opts, reply_markup: keyboard });
  } catch (err) {
    console.error('reply with buttons failed, sending plain:', err.message);
    return ctx.reply(html, opts);
  }
}

function invoiceCard(inv) {
  const status = inv.status === 'paid' ? '✅ Paid' : '⏳ Unpaid';
  return `🧾 <b>Invoice ${inv.id}</b>\n\n` +
    `<b>To:</b> ${esc(inv.client)}\n<b>For:</b> ${esc(inv.description)}\n` +
    `<b>Amount:</b> ${esc(amountLine(inv))}\n<b>Status:</b> ${status}\n\n` +
    `Forward this link to your client 👇\n${payLink(inv)}`;
}

const HELP =
  `<b>Create an invoice</b> in one line:\n<code>invoice Ayo $50 logo design</code>\n` +
  `<code>invoice KEY Academy ₦75000 press articles</code>\n<code>invoice Tom £40 website fixes</code>\n\n` +
  `Or tap <b>New invoice</b> and I'll ask you 3 quick questions.\n\n` +
  `/invoices – see who has paid\n/address – change your wallet address\n/name – change the name clients see`;

const mainMenu = () => new InlineKeyboard().text('🧾 New invoice', 'new').text('📋 My invoices', 'list');

export function createBot() {
  if (!config.botToken) {
    console.warn('BOT_TOKEN not set: Telegram bot is OFF (website still runs).');
    return null;
  }
  const bot = new Bot(config.botToken);

  const displayName = (from) => [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Freelancer';

  async function askAddress(ctx) {
    state.set(ctx.chat.id, { step: 'address' });
    await ctx.reply(
      `First, send me your <b>Bitcoin Cash address</b>. That's where your clients' payments will land.\n\n` +
      `In Paytaca: tap <b>Receive</b> → copy the address → paste it here.\n\n` +
      `🔒 Payday never holds your money. Clients pay you directly.`,
      { parse_mode: 'HTML' });
  }

  async function createInvoice(ctx, draft) {
    const me = freelancers.get(ctx.chat.id);
    if (!me) return askAddress(ctx);
    let amountCents;
    try {
      amountCents = await toUsdCents(draft.amount, draft.currency);
    } catch {
      return ctx.reply('Sorry, I could not get today\'s exchange rate. Please try again in a minute, or use $.');
    }
    if (amountCents < 1) return ctx.reply('That amount is too small. The minimum is $0.01.');
    if (amountCents > 10_000_00) return ctx.reply('For now the maximum is $10,000 per invoice.');

    const inv = invoices.create({
      chatId: ctx.chat.id, payeeName: me.name, payeeAddress: me.address,
      client: draft.client, description: draft.description,
      amountCents, inputAmount: draft.amount, inputCurrency: draft.currency,
    });
    state.delete(ctx.chat.id);
    await replyWithButtons(ctx, invoiceCard(inv), shareKeyboard(inv, clientMessage(inv)));
  }

  async function startGuided(ctx) {
    if (!freelancers.get(ctx.chat.id)) return askAddress(ctx);
    state.set(ctx.chat.id, { step: 'client', draft: {} });
    await ctx.reply('Who is the invoice for? (client\'s name)');
  }

  async function listInvoices(ctx) {
    const rows = invoices.listForChat(ctx.chat.id);
    if (!rows.length) return ctx.reply('No invoices yet. Tap New invoice to make your first one.', { reply_markup: mainMenu() });
    const paid = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount_cents, 0);
    const owed = rows.filter((r) => r.status !== 'paid').reduce((s, r) => s + r.amount_cents, 0);
    const lines = rows.map((r) =>
      `${r.status === 'paid' ? '✅' : '⏳'} <b>${esc(r.client)}</b>: ${fmt.usd(r.amount_cents)}, ${esc(r.description)} (<a href="${payLink(r)}">${r.id}</a>)`);
    const kb = new InlineKeyboard();
    rows.filter((r) => r.status !== 'paid').slice(0, 5).forEach((r) => kb.text(`🔔 Remind ${r.client}`.slice(0, 40), `remind:${r.id}`).row());
    await ctx.reply(
      `<b>Your invoices</b>\n\n${lines.join('\n')}\n\n💰 Paid: <b>${fmt.usd(paid)}</b>  ·  ⏳ Waiting: <b>${fmt.usd(owed)}</b>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb });
  }

  bot.command('start', async (ctx) => {
    const me = freelancers.get(ctx.chat.id);
    if (me) {
      return ctx.reply(`Welcome back, ${esc(me.name)} 👋\nPayments go to <code>${shortAddress(me.address)}</code>.\n\n${HELP}`,
        { parse_mode: 'HTML', reply_markup: mainMenu() });
    }
    await ctx.reply(`👋 Welcome to <b>Payday</b>\n\nSend invoices from this chat. Your clients pay in dollars (ParyonUSD) or Bitcoin Cash, straight to your wallet, and I'll tell you the moment they pay.`,
      { parse_mode: 'HTML' });
    await askAddress(ctx);
  });

  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', reply_markup: mainMenu() }));
  bot.command('new', startGuided);
  bot.command('invoices', listInvoices);
  bot.command('address', askAddress);
  bot.command('name', (ctx) => {
    if (!freelancers.get(ctx.chat.id)) return askAddress(ctx);
    state.set(ctx.chat.id, { step: 'name' });
    return ctx.reply('What name should clients see on your invoices? (e.g. your full name or business name)');
  });
  bot.command('cancel', (ctx) => { state.delete(ctx.chat.id); return ctx.reply('Cancelled.', { reply_markup: mainMenu() }); });

  bot.callbackQuery('new', async (ctx) => { await ctx.answerCallbackQuery(); await startGuided(ctx); });
  bot.callbackQuery('list', async (ctx) => { await ctx.answerCallbackQuery(); await listInvoices(ctx); });
  bot.callbackQuery(/^remind:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const inv = invoices.get(ctx.match[1]);
    if (!inv || inv.chat_id !== ctx.chat.id) return;
    if (inv.status === 'paid') return ctx.reply(`Good news: ${inv.client} already paid ✅`);
    const text = reminderMessage(inv);
    await replyWithButtons(ctx, `Here's a polite reminder for <b>${esc(inv.client)}</b>. Tap to send it 👇\n\n<i>${esc(text)}</i>`,
      shareKeyboard(inv, text));
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const s = state.get(ctx.chat.id);

    if (s?.step === 'address') {
      const addr = normalizeAddress(text);
      if (!addr) return ctx.reply('Hmm, that doesn\'t look like a Bitcoin Cash address. It should start with "bitcoincash:q…" or "bitcoincash:z…". Please paste it again.');
      const existing = freelancers.get(ctx.chat.id);
      freelancers.save(ctx.chat.id, existing?.name || displayName(ctx.from), addr.tokenAddress);
      state.delete(ctx.chat.id);
      return ctx.reply(`Saved ✅ Payments will go to <code>${shortAddress(addr.address)}</code>\n\n${HELP}`, { parse_mode: 'HTML', reply_markup: mainMenu() });
    }
    if (s?.step === 'name') {
      const me = freelancers.get(ctx.chat.id);
      freelancers.save(ctx.chat.id, text.slice(0, 60), me.address);
      state.delete(ctx.chat.id);
      return ctx.reply(`Done. Clients will see <b>${esc(text.slice(0, 60))}</b>.`, { parse_mode: 'HTML', reply_markup: mainMenu() });
    }
    if (s?.step === 'client') {
      s.draft.client = text.slice(0, 60); s.step = 'amount';
      return ctx.reply('How much? You can type $50, £40 or ₦75000.');
    }
    if (s?.step === 'amount') {
      const a = parseAmount(text.replace(/\s+/g, ''));
      if (!a) return ctx.reply('Please type just the amount, like $50, £40 or ₦75000.');
      s.draft.amount = a.value; s.draft.currency = a.currency; s.step = 'description';
      return ctx.reply('What is it for? (e.g. "logo design")');
    }
    if (s?.step === 'description') {
      s.draft.description = text.slice(0, 120);
      return createInvoice(ctx, s.draft);
    }

    const draft = parseInvoiceLine(text);
    if (draft) return createInvoice(ctx, draft);
    if (!freelancers.get(ctx.chat.id)) return askAddress(ctx);
    return ctx.reply(`I didn't catch that.\n\n${HELP}`, { parse_mode: 'HTML', reply_markup: mainMenu() });
  });

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));
  return bot;
}

// Called by the web server when a payment is confirmed on chain.
export async function notifyPaid(bot, inv) {
  if (!bot || !inv.chat_id) return;
  const proof = `https://explorer.bch.ninja/tx/${inv.txid}`;
  await bot.api.sendMessage(inv.chat_id,
    `🎉 <b>${esc(inv.client)} paid ${fmt.usd(inv.amount_cents)}</b> in ${inv.paid_with === 'PUSD' ? 'ParyonUSD' : 'BCH'}\n` +
    `For: ${esc(inv.description)}\n\nThe money is already in your wallet. <a href="${proof}">See proof on the blockchain</a>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch((e) => console.error('notify failed', e.message));
}
