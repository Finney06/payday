// Live prices, with backups, because free APIs often rate-limit shared hosting IPs.
// - BCH/USD: CoinGecko, then Coinbase Exchange, then Kraken (cached 5 min)
// - USD -> GBP / NGN: open.er-api.com, then derived from CoinGecko (cached 6 h)
// If every source fails we keep serving the last good values.

const BCH_TTL = 5 * 60 * 1000;
const FX_TTL = 6 * 60 * 60 * 1000;
const UA = { 'user-agent': 'Payday/1.0 (+https://github.com/Finney06/payday)', accept: 'application/json' };

let bch = null; // { usd, at }
let fx = null;  // { gbp, ngn, at }
let geckoFx = null; // FX derived from CoinGecko, used only if open.er-api fails

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

const bchSources = [
  async () => {
    const p = (await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd,gbp,ngn'))['bitcoin-cash'];
    if (p?.gbp && p?.ngn) geckoFx = { gbp: p.gbp / p.usd, ngn: p.ngn / p.usd, at: Date.now() };
    return p?.usd;
  },
  async () => Number((await getJson('https://api.exchange.coinbase.com/products/BCH-USD/ticker')).price),
  async () => {
    const r = (await getJson('https://api.kraken.com/0/public/Ticker?pair=BCHUSD')).result;
    return Number(Object.values(r || {})[0]?.c?.[0]);
  },
];

async function loadBch() {
  if (bch && Date.now() - bch.at < BCH_TTL) return bch;
  const errors = [];
  for (const source of bchSources) {
    try {
      const usd = await source();
      if (usd > 0 && Number.isFinite(usd)) return (bch = { usd, at: Date.now() });
    } catch (e) { errors.push(e.message); }
  }
  if (bch) return bch;
  throw new Error(`Could not load the BCH price (${errors.join('; ')})`);
}

async function loadFx() {
  if (fx && Date.now() - fx.at < FX_TTL) return fx;
  try {
    const d = await getJson('https://open.er-api.com/v6/latest/USD');
    if (d?.rates?.NGN > 0 && d?.rates?.GBP > 0) return (fx = { gbp: d.rates.GBP, ngn: d.rates.NGN, at: Date.now() });
    throw new Error('missing NGN/GBP');
  } catch (e) {
    if (geckoFx) return (fx = geckoFx);
    if (fx) return fx;
    throw new Error(`Could not load exchange rates (${e.message})`);
  }
}

export async function getRates() {
  const [b, f] = await Promise.all([loadBch(), loadFx()]);
  return { bchUsd: b.usd, usdGbp: f.gbp, usdNgn: f.ngn, at: Math.min(b.at, f.at) };
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
