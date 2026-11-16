import { readFileSync, existsSync } from 'node:fs';

// Tiny .env loader so we don't need another dependency.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  botUsername: process.env.BOT_USERNAME || '',
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || './data/payday.db',
  network: process.env.NETWORK || 'mainnet', // mainnet | chipnet
  // ParyonUSD CashToken category on mainnet
  pusdCategory: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
};
