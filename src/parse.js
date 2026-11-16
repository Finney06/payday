// Turns one chat line like "invoice Ayo $50 logo design" into an invoice draft.

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
  return { value, currency: currency ?? 'USD', usedNext };
}

export function parseInvoiceLine(text) {
  const words = text.trim().replace(/^\/?(invoice|bill|new)\b:?/i, '').trim().split(/\s+/).filter(Boolean);
  const i = words.findIndex((w, idx) => parseAmount(w, words[idx + 1]));
  if (i < 1) return null; // need a client name before the amount

  const amount = parseAmount(words[i], words[i + 1]);
  const client = words.slice(0, i).join(' ').replace(/^(to|for)\s+/i, '');
  let description = words.slice(i + 1 + (amount.usedNext ? 1 : 0)).join(' ');
  description = description.replace(/^for\s+/i, '').trim();

  return {
    client: client.slice(0, 60),
    amount: amount.value,
    currency: amount.currency,
    description: description.slice(0, 120) || 'Services',
  };
}
