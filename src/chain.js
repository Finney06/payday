// Talks to the Bitcoin Cash network through public Electrum (Fulcrum) servers.
// One shared connection, with automatic fail-over to the next server.
import { ElectrumClient } from '@electrum-cash/network';
import { config } from './config.js';

const SERVERS = {
  mainnet: ['bch.imaginary.cash', 'electrum.imaginary.cash', 'cashnode.bch.ninja', 'bch.loping.net', 'fulcrum.greyh.at'],
  chipnet: ['chipnet.imaginary.cash', 'chipnet.bch.ninja'],
};

const CONNECT_TIMEOUT = 8000;
const REQUEST_TIMEOUT = 15000;

let client = null;
let connecting = null;
let nextServer = 0;

const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref?.()),
]);

async function connect() {
  const servers = SERVERS[config.network] || SERVERS.mainnet;
  let lastError;
  for (let i = 0; i < servers.length; i++) {
    const host = servers[(nextServer + i) % servers.length];
    const c = new ElectrumClient('Payday', '1.5.0', host);
    try {
      await withTimeout(c.connect(), CONNECT_TIMEOUT, `Connecting to ${host}`);
      nextServer = (nextServer + i) % servers.length;
      c.on('disconnected', () => { if (client === c) client = null; });
      return c;
    } catch (err) {
      lastError = err;
      c.disconnect(true).catch(() => {});
    }
  }
  throw new Error(`Could not reach the Bitcoin Cash network (${lastError?.message || 'no servers'})`);
}

async function getClient() {
  if (client) return client;
  if (!connecting) {
    connecting = connect().then((c) => { client = c; return c; }).finally(() => { connecting = null; });
  }
  return connecting;
}

// An error the Electrum server itself returned (e.g. "transaction rejected"), as
// opposed to a network problem. These are not worth retrying on another server.
export class ChainError extends Error {}

export async function rpc(method, ...params) {
  for (let attempt = 0; ; attempt++) {
    let c;
    try {
      c = await getClient();
      const result = await withTimeout(c.request(method, ...params), REQUEST_TIMEOUT, method);
      if (result instanceof Error) throw new ChainError(result.message);
      return result;
    } catch (err) {
      if (err instanceof ChainError || attempt >= 1) throw err;
      // Connection trouble: drop this server and try the next one once.
      if (c && client === c) { client = null; c.disconnect(true).catch(() => {}); }
      nextServer++;
    }
  }
}

export const chain = {
  // Unspent coins for a script hash, including CashTokens.
  listUnspent: (scripthash) => rpc('blockchain.scripthash.listunspent', scripthash, 'include_tokens'),
  // Has this script hash ever received anything? (null = never used)
  async everUsed(scripthash) {
    try { return (await rpc('blockchain.scripthash.get_first_use', scripthash)) !== null; } catch (err) {
      if (err instanceof ChainError) return null; // server doesn't support it: caller falls back
      throw err;
    }
  },
  broadcast: (txHex) => rpc('blockchain.transaction.broadcast', txHex),
  getTx: (txid) => rpc('blockchain.transaction.get', txid, false),
  // Current block height, or null if the server can't say.
  async tipHeight() {
    try { return (await rpc('blockchain.headers.get_tip'))?.height ?? null; } catch {
      try { return (await rpc('blockchain.headers.subscribe'))?.height ?? null; } catch { return null; }
    }
  },
};
