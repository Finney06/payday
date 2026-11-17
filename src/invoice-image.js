// Renders an invoice (or paid receipt) as a PNG image, for Telegram and WhatsApp link previews.
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { getRates } from './rates.js';

const fontDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const FONTS = ['Geist-Regular', 'Geist-Medium', 'Geist-SemiBold', 'Geist-Bold', 'GeistMono-Regular', 'GeistMono-Medium']
  .map((f) => join(fontDir, `${f}.ttf`));

const C = {
  page: '#f1ede5', card: '#f9f6f0', ink: '#24212a', muted: '#5e6470', faint: '#8b909b', line: '#e8e6e1',
  accent: '#5b37e6', accentSoft: '#f1edff', warn: '#85560a', warnSoft: '#fcf0d6', paid: '#0f7b4a', paidSoft: '#e4f5ec',
};
const W = 1080, H = 1350, PAD = 72;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const date = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function logo(x, y, size) {
  const s = size / 256;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect width="256" height="256" rx="64" fill="${C.accent}"/>
    <path d="M76 74h62a42 42 0 0 1 0 84h-34v34H76z" fill="none" stroke="#fff" stroke-width="22" stroke-linejoin="round"/>
    <path d="M148 186l14 14 30-34" fill="none" stroke="#ffd75e" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

function row(y, label, value) {
  return `<text x="${PAD + 48}" y="${y}" font-family="Geist Mono" font-size="24" letter-spacing="2" fill="${C.faint}">${esc(label.toUpperCase())}</text>
    <text x="${W - PAD - 48}" y="${y}" text-anchor="end" font-family="Geist" font-weight="500" font-size="34" fill="${C.ink}">${esc(value)}</text>
    <line x1="${PAD + 48}" y1="${y + 30}" x2="${W - PAD - 48}" y2="${y + 30}" stroke="${C.line}" stroke-width="2"/>`;
}

async function qrSvg(text, x, y, size) {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: C.ink, light: '#ffffff' } });
  return svg.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

export async function renderInvoicePng(inv) {
  const paid = inv.status === 'paid';
  const payUrl = `${config.baseUrl}/pay/${inv.id}`;
  let sub = '';
  if (inv.input_currency === 'NGN') sub = `NGN ${num(inv.input_amount)} at today's rate`;
  else if (inv.input_currency === 'GBP') sub = `£${num(inv.input_amount, 2)} at today's rate`;
  else {
    try {
      const r = await getRates();
      sub = `≈ NGN ${num((inv.amount_cents / 100) * r.usdNgn)} · £${num((inv.amount_cents / 100) * r.usdGbp, 2)}`;
    } catch { /* rates are optional */ }
  }

  const top = 150; // card top
  const pill = paid
    ? { text: 'PAID', fg: C.paid, bg: C.paidSoft }
    : { text: 'UNPAID', fg: C.warn, bg: C.warnSoft };
  const pillW = pill.text.length * 17 + 64;

  let bottom;
  if (paid) {
    const tx = inv.txid ? `${inv.txid.slice(0, 10)}…${inv.txid.slice(-8)}` : '';
    bottom = `
      <g transform="translate(${W / 2} 990) rotate(-6)">
        <rect x="-190" y="-70" width="380" height="140" rx="20" fill="none" stroke="${C.paid}" stroke-width="8"/>
        <text x="0" y="30" text-anchor="middle" font-family="Geist" font-weight="700" font-size="92" letter-spacing="10" fill="${C.paid}">PAID</text>
      </g>
      <text x="${W / 2}" y="1140" text-anchor="middle" font-family="Geist" font-size="30" fill="${C.muted}">Paid in ${inv.paid_with === 'PUSD' ? 'ParyonUSD' : 'BCH'} on ${esc(date(inv.paid_at))}</text>
      <text x="${W / 2}" y="1182" text-anchor="middle" font-family="Geist Mono" font-size="24" fill="${C.faint}">Proof on the blockchain: ${esc(tx)}</text>`;
  } else {
    const q = 280, qx = PAD + 48, qy = 905;
    bottom = `
      <rect x="${qx - 14}" y="${qy - 14}" width="${q + 28}" height="${q + 28}" rx="20" fill="#fff" stroke="${C.line}" stroke-width="2"/>
      ${await qrSvg(payUrl, qx, qy, q)}
      <text x="${qx + q + 56}" y="${qy + 52}" font-family="Geist" font-weight="600" font-size="42" fill="${C.ink}">Scan to pay</text>
      <text x="${qx + q + 56}" y="${qy + 104}" font-family="Geist" font-size="30" fill="${C.muted}">in dollars (ParyonUSD)</text>
      <text x="${qx + q + 56}" y="${qy + 146}" font-family="Geist" font-size="30" fill="${C.muted}">or Bitcoin Cash.</text>
      <text x="${qx + q + 56}" y="${qy + 222}" font-family="Geist Mono" font-size="22" fill="${C.accent}">${esc(clip(payUrl.replace(/^https?:\/\//, ''), 34))}</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.page}"/>
    ${logo(PAD, 52, 64)}
    <text x="${PAD + 84}" y="98" font-family="Geist" font-weight="600" font-size="38" fill="${C.ink}">Payday</text>
    <text x="${W - PAD}" y="96" text-anchor="end" font-family="Geist Mono" font-size="24" letter-spacing="2" fill="${C.muted}">INVOICE ${esc(inv.id.toUpperCase())}</text>

    <rect x="${PAD}" y="${top}" width="${W - PAD * 2}" height="${H - top - 110}" rx="36" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>

    <text x="${PAD + 48}" y="${top + 82}" font-family="Geist Mono" font-size="24" letter-spacing="2" fill="${C.faint}">INVOICE FROM</text>
    <text x="${PAD + 48}" y="${top + 132}" font-family="Geist" font-weight="600" font-size="42" fill="${C.ink}">${esc(clip(inv.payee_name, 26))}</text>
    <rect x="${W - PAD - 48 - pillW}" y="${top + 56}" width="${pillW}" height="52" rx="26" fill="${pill.bg}"/>
    <circle cx="${W - PAD - 48 - pillW + 30}" cy="${top + 82}" r="7" fill="${pill.fg}"/>
    <text x="${W - PAD - 48 - pillW + 48}" y="${top + 91}" font-family="Geist Mono" font-weight="500" font-size="24" letter-spacing="2" fill="${pill.fg}">${pill.text}</text>

    <text x="${PAD + 44}" y="${top + 290}" font-family="Geist" font-weight="700" font-size="${inv.amount_cents >= 100_000_00 ? 120 : 140}" letter-spacing="-4" fill="${C.ink}">${usd(inv.amount_cents)}</text>
    <text x="${PAD + 48}" y="${top + 350}" font-family="Geist" font-size="32" fill="${C.muted}">${esc(sub)}</text>

    ${row(top + 450, 'For', clip(inv.description, 30))}
    ${row(top + 530, 'Billed to', clip(inv.client, 30))}
    ${row(top + 610, 'Date', date(inv.created_at))}

    <line x1="${PAD}" y1="${top + 690}" x2="${W - PAD}" y2="${top + 690}" stroke="${C.line}" stroke-width="3" stroke-dasharray="12 12"/>
    ${bottom}

    <text x="${W / 2}" y="${H - 50}" text-anchor="middle" font-family="Geist" font-size="26" fill="${C.faint}">Paid straight to ${esc(clip(inv.payee_name, 24))}'s wallet · Payday never holds your money</text>
  </svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' },
  }).render().asPng();
  return png;
}
