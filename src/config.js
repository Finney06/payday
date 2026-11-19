import { readFileSync, existsSync } from 'node:fs';

// Tiny .env loader so we don't need another dependency.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Treat placeholder values typed into a hosting dashboard as empty.
const opt = (v) => (!v || /^(none|-|n\/a|todo)$/i.test(v.trim()) ? '' : v.trim());

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  botUsername: process.env.BOT_USERNAME || '',
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || './data/payday.db',
  network: process.env.NETWORK || 'mainnet', // mainnet | chipnet
  // Hackathon banner + "Try it" demo invoice
  repoUrl: process.env.REPO_URL || 'https://github.com/Finney06/payday',
  slidesUrl: opt(process.env.SLIDES_URL),
  emberAddress: opt(process.env.EMBER_ADDRESS) || 'bitcoincash:zzhuv665eghtsamz4n4hhjjwkwutruu5s5zpqke8x0',
  demoName: process.env.DEMO_NAME || 'Finney Osajere',
  demoAddress: process.env.DEMO_ADDRESS || '',
  demoChatId: process.env.DEMO_CHAT_ID ? Number(process.env.DEMO_CHAT_ID) : null,
  demoCents: Number(process.env.DEMO_CENTS || 5),
  // Telegram chat that gets an alert when a payer hits an error (defaults to the demo freelancer's chat)
  alertChatId: process.env.ALERT_CHAT_ID ? Number(process.env.ALERT_CHAT_ID) : (process.env.DEMO_CHAT_ID ? Number(process.env.DEMO_CHAT_ID) : null),
  // ParyonUSD CashToken category on mainnet
  pusdCategory: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
};
