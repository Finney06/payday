import { Bot, InlineKeyboard, Keyboard, InputFile } from 'grammy';
import { renderInvoicePng } from './invoice-image.js';
import { config } from './config.js';
import { freelancers, invoices } from './db.js';
import { normalizeAddress, shortAddress } from './address.js';
import { parseInvoiceLine, parseAmount, startsInvoiceLine } from './parse.js';
import { toUsdCents, fmt } from './rates.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const payLink = (inv) => `${config.baseUrl}/pay/${inv.id}`;
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

// Bottom-of-chat menu, always visible.
const BTN_NEW = '🧾 New invoice';
const BTN_LIST = '📋 My invoices';
const BTN_HELP = '❓ Help';
const menu = new Keyboard().text(BTN_NEW).text(BTN_LIST).row().text(BTN_HELP).resized().persistent();

// What each chat is in the middle of: address setup, name change, or the guided invoice questions.
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

function shareKeyboard(inv, text, { withDelete = false } = {}) {
  const kb = new InlineKeyboard()
    .url('📲 Send on WhatsApp', `https://wa.me/?text=${encodeURIComponent(text)}`).row()
    .url('✈️ Share on Telegram', `https://t.me/share/url?url=${encodeURIComponent(payLink(inv))}&text=${encodeURIComponent(text.split('\n')[0])}`);
  // Telegram only accepts public URLs on buttons (not localhost).
  if (/^https:\/\//.test(config.baseUrl)) kb.row().url('👀 Open pay page', payLink(inv));
  if (withDelete) kb.row().text('🗑 Delete invoice', `del:${inv.id}`);
  return kb;
}

// Send the invoice as an image with the details as caption; fall back to plain text if the image fails.
async function replyWithInvoice(ctx, inv, html, keyboard) {
  try {
    const png = await renderInvoicePng(inv);
    return await ctx.replyWithPhoto(new InputFile(png, `invoice-${inv.id}.png`), { caption: html, parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    console.error('invoice image failed, sending text:', err.message);
    return replyWithButtons(ctx, html, keyboard);
  }
}

// Send with buttons; if Telegram rejects the buttons for any reason, still send the text.
async function replyWithButtons(ctx, html, keyboard) {
  try {
    return await ctx.reply(html, { ...HTML, reply_markup: keyboard });
  } catch (err) {
    console.error('reply with buttons failed, sending plain:', err.message);
    return ctx.reply(html, HTML);
  }
}

function invoiceCard(inv) {
  const status = inv.status === 'paid' ? '✅ Paid' : '⏳ Unpaid';
  return `🧾 <b>Invoice ${inv.id}</b>\n\n` +
    `<b>To:</b> ${esc(inv.client)}\n<b>For:</b> ${esc(inv.description)}\n` +
    `<b>Amount:</b> ${esc(amountLine(inv))}\n<b>Status:</b> ${status}\n\n` +
    `Send this to your client 👇\n${payLink(inv)}`;
}

function draftSummary(d) {
  const amount = d.currency === 'USD' ? fmt.input(d.amount, 'USD') : `${fmt.input(d.amount, d.currency)} (paid in $ at today's rate)`;
  return `Please check 👇\n\n<b>To:</b> ${esc(d.client)}\n<b>Amount:</b> ${esc(amount)}\n<b>For:</b> ${esc(d.description)}`;
}

const HELP =
  `<b>Fastest way:</b> type one line\n<code>invoice Sarah $50 logo design</code>\n` +
  `<code>invoice Bright Studio ₦75000 flyer design</code>\n<code>invoice Tom £40 website fixes</code>\n\n` +
  `Or tap <b>${BTN_NEW}</b> and I'll ask you 3 quick questions.\n\n` +
  `${BTN_LIST}: see who has paid, send reminders\n/address: change your wallet address\n/name: change the name clients see`;

const cancelKb = () => new InlineKeyboard().text('✖️ Cancel', 'cancel');

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
      `Send me your <b>Bitcoin Cash address</b>. That's where your clients' payments will land.\n\n` +
      `In Paytaca: tap <b>Receive</b> → copy the address → paste it here.\n\n` +
      `🔒 Payday never holds your money. Clients pay you directly.`, HTML);
  }

  async function createInvoice(ctx, draft) {
    const me = await freelancers.get(ctx.chat.id);
    if (!me) return askAddress(ctx);
    let amountCents;
    try {
      amountCents = await toUsdCents(draft.amount, draft.currency);
    } catch {
      return ctx.reply('Sorry, I couldn\'t get today\'s exchange rate. Please try again in a minute, or use $.', { reply_markup: menu });
    }
    if (amountCents < 1) return ctx.reply('That amount is too small. The minimum is $0.01.', { reply_markup: menu });
    if (amountCents > 10_000_00) return ctx.reply('For now the maximum is $10,000 per invoice.', { reply_markup: menu });

    const inv = await invoices.create({
      chatId: ctx.chat.id, payeeName: me.name, payeeAddress: me.address,
      client: draft.client, description: draft.description,
      amountCents, inputAmount: draft.amount, inputCurrency: draft.currency,
    });
    state.delete(ctx.chat.id);
    await replyWithInvoice(ctx, inv, invoiceCard(inv), shareKeyboard(inv, clientMessage(inv), { withDelete: true }));
  }

  async function startGuided(ctx) {
    if (!await freelancers.get(ctx.chat.id)) return askAddress(ctx);
    state.set(ctx.chat.id, { step: 'client', draft: {} });
    await ctx.reply('<b>1/3</b> Who is the invoice for? (your client\'s name)', { ...HTML, reply_markup: cancelKb() });
  }

  async function askDescription(ctx, s) {
    s.step = 'description';
    await ctx.reply('<b>3/3</b> What is it for? (e.g. <i>logo design</i>)', { ...HTML, reply_markup: cancelKb() });
  }

  async function confirmDraft(ctx, s) {
    s.step = 'confirm';
    const kb = new InlineKeyboard().text('✅ Create invoice', 'confirm').row()
      .text('✏️ Start over', 'restart').text('✖️ Cancel', 'cancel');
    await ctx.reply(draftSummary(s.draft), { ...HTML, reply_markup: kb });
  }

  async function listInvoices(ctx) {
    const rows = await invoices.listForChat(ctx.chat.id);
    if (!rows.length) return ctx.reply(`No invoices yet. Tap <b>${BTN_NEW}</b> to make your first one.`, { ...HTML, reply_markup: menu });
    const paid = rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount_cents, 0);
    const owed = rows.filter((r) => r.status !== 'paid').reduce((s, r) => s + r.amount_cents, 0);
    const lines = rows.map((r) =>
      `${r.status === 'paid' ? '✅' : '⏳'} <b>${esc(r.client)}</b>: ${fmt.usd(r.amount_cents)}, ${esc(r.description)} · <a href="${payLink(r)}">${r.id}</a>`);
    const kb = new InlineKeyboard();
    rows.filter((r) => r.status !== 'paid').slice(0, 6).forEach((r) =>
      kb.text(`🔔 Remind ${r.client}`.slice(0, 30), `remind:${r.id}`).text('🗑', `del:${r.id}`).row());
    await ctx.reply(
      `<b>Your invoices</b>\n\n${lines.join('\n')}\n\n💰 Paid: <b>${fmt.usd(paid)}</b>  ·  ⏳ Waiting: <b>${fmt.usd(owed)}</b>`,
      { ...HTML, reply_markup: kb });
  }

  const sendHelp = (ctx) => ctx.reply(HELP, { ...HTML, reply_markup: menu });

  // ---------- commands ----------
  bot.command('start', async (ctx) => {
    state.delete(ctx.chat.id);
    const me = await freelancers.get(ctx.chat.id);
    if (me) {
      return ctx.reply(`Welcome back, ${esc(me.name)} 👋\nPayments go to <code>${shortAddress(me.address)}</code>.\n\n${HELP}`, { ...HTML, reply_markup: menu });
    }
    await ctx.reply(`👋 <b>Welcome to Payday</b>\n\nSend invoices from this chat. Your clients pay in dollars (ParyonUSD) or Bitcoin Cash, straight to your wallet, and I'll tell you the moment they pay.\n\nSetup takes 30 seconds.`, HTML);
    await askAddress(ctx);
  });
  bot.command('help', sendHelp);
  bot.command('new', startGuided);
  bot.command('invoices', listInvoices);
  bot.command('address', askAddress);
  bot.command('name', async (ctx) => {
    if (!await freelancers.get(ctx.chat.id)) return askAddress(ctx);
    state.set(ctx.chat.id, { step: 'name' });
    return ctx.reply('What name should clients see on your invoices? (your full name or business name)', { reply_markup: cancelKb() });
  });
  bot.command('cancel', (ctx) => { state.delete(ctx.chat.id); return ctx.reply('Cancelled.', { reply_markup: menu }); });

  // ---------- buttons ----------
  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled');
    state.delete(ctx.chat.id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply('Cancelled. Nothing was created.', { reply_markup: menu });
  });
  bot.callbackQuery('restart', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await startGuided(ctx);
  });
  bot.callbackQuery('confirm', async (ctx) => {
    const s = state.get(ctx.chat.id);
    if (s?.step !== 'confirm') return ctx.answerCallbackQuery('This one expired. Please start again.');
    await ctx.answerCallbackQuery('Creating…');
    await ctx.editMessageReplyMarkup().catch(() => {});
    await createInvoice(ctx, s.draft);
  });
  bot.callbackQuery(/^cur:(USD|GBP|NGN)$/, async (ctx) => {
    const s = state.get(ctx.chat.id);
    if (s?.step !== 'currency') return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    s.draft.currency = ctx.match[1];
    await ctx.editMessageText(`Amount: <b>${esc(fmt.input(s.draft.amount, s.draft.currency))}</b> ✓`, HTML).catch(() => {});
    await askDescription(ctx, s);
  });
  bot.callbackQuery(/^remind:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const inv = await invoices.get(ctx.match[1]);
    if (!inv || inv.chat_id !== ctx.chat.id) return;
    if (inv.status === 'paid') return ctx.reply(`Good news: ${inv.client} already paid ✅`);
    const text = reminderMessage(inv);
    await replyWithButtons(ctx, `Here's a polite reminder for <b>${esc(inv.client)}</b>. Tap to send it 👇\n\n<i>${esc(text)}</i>`, shareKeyboard(inv, text));
  });
  bot.callbackQuery(/^del:(\w+)$/, async (ctx) => {
    const inv = await invoices.get(ctx.match[1]);
    if (!inv || inv.chat_id !== ctx.chat.id) return ctx.answerCallbackQuery('Not found');
    if (inv.status === 'paid') return ctx.answerCallbackQuery('Paid invoices can\'t be deleted');
    const kb = new InlineKeyboard().text('Yes, delete it', `delyes:${inv.id}`).text('No, keep it', 'delno');
    await ctx.answerCallbackQuery();
    await ctx.reply(`Delete the invoice to <b>${esc(inv.client)}</b> for ${fmt.usd(inv.amount_cents)}? The pay link will stop working.`, { ...HTML, reply_markup: kb });
  });
  bot.callbackQuery(/^delyes:(\w+)$/, async (ctx) => {
    const ok = await invoices.deleteUnpaid(ctx.match[1], ctx.chat.id);
    await ctx.answerCallbackQuery(ok ? 'Deleted' : 'Could not delete');
    await ctx.editMessageText(ok ? '🗑 Invoice deleted.' : 'That invoice was already paid or deleted.').catch(() => {});
  });
  bot.callbackQuery('delno', async (ctx) => {
    await ctx.answerCallbackQuery('Kept');
    await ctx.editMessageText('Okay, kept it.').catch(() => {});
  });

  // ---------- text messages ----------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    // Menu buttons work from anywhere.
    if (text === BTN_NEW) { state.delete(ctx.chat.id); return startGuided(ctx); }
    if (text === BTN_LIST) { state.delete(ctx.chat.id); return listInvoices(ctx); }
    if (text === BTN_HELP) { state.delete(ctx.chat.id); return sendHelp(ctx); }

    const s = state.get(ctx.chat.id);

    if (s?.step === 'address') {
      const addr = normalizeAddress(text);
      if (!addr) return ctx.reply('Hmm, that doesn\'t look like a Bitcoin Cash address. It starts with "bitcoincash:q…" or "bitcoincash:z…". Please paste it again.');
      const existing = await freelancers.get(ctx.chat.id);
      const name = existing?.name || displayName(ctx.from);
      await freelancers.save(ctx.chat.id, name, addr.tokenAddress);
      state.delete(ctx.chat.id);
      return ctx.reply(
        `✅ All set! Payments go to <code>${shortAddress(addr.address)}</code>\n` +
        `Clients will see your name as <b>${esc(name)}</b> (change it with /name).\n\n${HELP}`, { ...HTML, reply_markup: menu });
    }

    // A full one-liner always works, even in the middle of the questions.
    if (s?.step !== 'name' && s?.step !== 'description') {
      const draft = parseInvoiceLine(text);
      if (draft && /^(invoice|bill|new)\b/i.test(text)) return createInvoice(ctx, draft);
    }

    if (s?.step === 'name') {
      const me = await freelancers.get(ctx.chat.id);
      await freelancers.save(ctx.chat.id, text.slice(0, 60), me.address);
      state.delete(ctx.chat.id);
      return ctx.reply(`Done. Clients will see <b>${esc(text.slice(0, 60))}</b>.`, { ...HTML, reply_markup: menu });
    }
    if (s?.step === 'client') {
      s.draft.client = text.slice(0, 60);
      s.step = 'amount';
      return ctx.reply('<b>2/3</b> How much? (e.g. <i>$50</i>, <i>£40</i> or <i>₦75000</i>)', { ...HTML, reply_markup: cancelKb() });
    }
    if (s?.step === 'amount' || s?.step === 'currency') {
      const a = parseAmount(text.replace(/\s+/g, ''));
      if (!a) return ctx.reply('Please type just the amount, like $50, £40 or ₦75000.', { reply_markup: cancelKb() });
      s.draft.amount = a.value;
      if (!a.explicit) {
        s.step = 'currency';
        const kb = new InlineKeyboard()
          .text(`$${a.value} USD`, 'cur:USD').text(`£${a.value} GBP`, 'cur:GBP').text(`₦${a.value} NGN`, 'cur:NGN');
        return ctx.reply(`${a.value} in which currency?`, { reply_markup: kb });
      }
      s.draft.currency = a.currency;
      return askDescription(ctx, s);
    }
    if (s?.step === 'description') {
      s.draft.description = text.slice(0, 120);
      return confirmDraft(ctx, s);
    }
    if (s?.step === 'confirm') {
      return ctx.reply('Tap ✅ Create invoice above, or ✏️ Start over.');
    }

    // Not in any flow.
    if (!await freelancers.get(ctx.chat.id)) return askAddress(ctx);
    const draft = parseInvoiceLine(text);
    if (draft) return createInvoice(ctx, draft);
    return ctx.reply(`I didn't catch that 🙂\n\n${HELP}`, { ...HTML, reply_markup: menu });
  });

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));
  return bot;
}

// Shown on the bot's profile before someone taps Start.
export async function setBotProfile(bot) {
  await bot.api.setMyDescription(
    'Send invoices from this chat.\n\nYour clients pay in dollars (ParyonUSD) or Bitcoin Cash, straight to your wallet, and Payday tells you the moment they pay.\n\n🔒 Payday never holds your money.').catch(() => {});
  await bot.api.setMyShortDescription('Send invoices from chat. Get paid in dollars on Bitcoin Cash.').catch(() => {});
  await bot.api.setMyCommands([
    { command: 'new', description: 'Create a new invoice' },
    { command: 'invoices', description: 'See who has paid' },
    { command: 'address', description: 'Change your wallet address' },
    { command: 'name', description: 'Change the name clients see' },
    { command: 'help', description: 'How to use Payday' },
  ]).catch(() => {});
}

// Called by the web server when a payment is confirmed on chain.
export async function notifyPaid(bot, inv) {
  if (!bot || !inv.chat_id) return;
  const proof = `https://explorer.bch.ninja/tx/${inv.txid}`;
  const text = `🎉 <b>${esc(inv.client)} paid ${fmt.usd(inv.amount_cents)}</b> in ${inv.paid_with === 'PUSD' ? 'ParyonUSD' : 'BCH'}\n` +
    `For: ${esc(inv.description)}\n\nThe money is already in your wallet. <a href="${proof}">See proof on the blockchain</a>`;
  try {
    const png = await renderInvoicePng(inv);
    await bot.api.sendPhoto(inv.chat_id, new InputFile(png, `receipt-${inv.id}.png`), { caption: text, parse_mode: 'HTML' });
  } catch (err) {
    console.error('receipt image failed, sending text:', err.message);
    await bot.api.sendMessage(inv.chat_id, text, HTML).catch((e) => console.error('notify failed', e.message));
  }
}
