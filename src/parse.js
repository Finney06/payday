// Turns one chat line like "invoice Sarah $50 logo design" into an invoice draft.

const CURRENCY_WORDS = {
  usd: 'USD', dollar: 'USD', dollars: 'USD', pusd: 'USD',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
  ngn: 'NGN', naira: 'NGN',
};
const SYMBOLS = { $: 'USD', '£': 'GBP', '₦': 'NGN', n: 'NGN' };

// "$50", "£1,200.50", "₦20k", "N20000", "50usd", "50"
const AMOUNT_RE = /^([$£₦]|n(?=\d))?(\d[\d,]*(?:\.\d{1,2})?)(k)?([a-z]+)?$/i;

export function parseAmount(token, nextToken = '') {
  const m = AMOUNT_RE.exec(token.trim());
  if (!m) return null;
  const [, symbol, digits, k, suffix] = m;
  let value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (k) value *= 1000;

  let currency = symbol ? SYMBOLS[symbol.toLowerCase()] : null;
  let usedNext = false;
  if (!currency && suffix) currency = CURRENCY_WORDS[suffix.toLowerCase()] ?? null;
  if (!currency && suffix) return null; // "50abc" is not an amount
  if (!currency && nextToken && CURRENCY_WORDS[nextToken.toLowerCase()]) {
    currency = CURRENCY_WORDS[nextToken.toLowerCase()];
    usedNext = true;
  }
  return { value, currency: currency ?? 'USD', usedNext, explicit: !!currency };
}

// "invoice", "/invoice", "make me an invoice", "please create a new invoice", "can you send a bill"
const INVOICE_START = /^\/?(?:(?:please|pls|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:(?:make|create|send|generate|prepare|draft|write)\s+(?:me\s+)?(?:(?:an?|the)\s+)?(?:new\s+)?)?(?:invoice|bill|new)\b:?\s*/i;

export const startsInvoiceLine = (text) => INVOICE_START.test(text.trim());

export function parseInvoiceLine(text) {
  const words = text.trim().replace(INVOICE_START, '').trim().split(/\s+/).filter(Boolean);
  const i = words.findIndex((w, idx) => parseAmount(w, words[idx + 1]));
  if (i < 0) return null;

  const amount = parseAmount(words[i], words[i + 1]);
  let client = words.slice(0, i).join(' ').replace(/^(?:to|for)(?:\s+|$)/i, '').replace(/\s+(?:for|of)$/i, '').trim();
  let description = words.slice(i + 1 + (amount.usedNext ? 1 : 0)).join(' ').trim();
  if (client) {
    description = description.replace(/^for\s+/i, '').trim();
  } else {
    // "invoice $50 to Sarah for logo design"
    const after = /^(?:to|for)\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(description);
    if (!after) return null; // need a client name
    client = after[1].trim();
    description = (after[2] || '').trim();
  }

  return {
    client: client.slice(0, 60),
    amount: amount.value,
    currency: amount.currency,
    description: description.slice(0, 120) || 'Services',
  };
}
