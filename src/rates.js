// Live prices: BCH in USD/GBP/NGN from CoinGecko, cached for 5 minutes.
// From those we derive USD->GBP and USD->NGN without a second API.

const URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd,gbp,ngn';
const TTL = 5 * 60 * 1000;
let cache = null;

export async function getRates() {
  if (cache && Date.now() - cache.at < TTL) return cache.rates;
  try {
    const res = await fetch(URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { 'bitcoin-cash': p } = await res.json();
    if (!p?.usd) throw new Error('no price');
    const rates = {
      bchUsd: p.usd,
      usdGbp: p.gbp / p.usd,
      usdNgn: p.ngn / p.usd,
      at: Date.now(),
    };
    cache = { at: Date.now(), rates };
    return rates;
  } catch (err) {
    if (cache) return cache.rates; // stale is better than nothing
    throw new Error(`Could not load exchange rates: ${err.message}`);
  }
}

// Convert what the freelancer typed into USD cents.
export async function toUsdCents(amount, currency) {
  if (currency === 'USD') return Math.round(amount * 100);
  const r = await getRates();
  const usd = currency === 'GBP' ? amount / r.usdGbp : amount / r.usdNgn;
  return Math.round(usd * 100);
}

export const fmt = {
  usd: (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  input: (amount, currency) => {
    const sym = { USD: '$', GBP: '£', NGN: '₦' }[currency];
    const digits = currency === 'NGN' ? 0 : 2;
    return sym + amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
};
