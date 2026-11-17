import { cashAddressToLockingBytecode, lockingBytecodeToCashAddress, binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { config } from './config.js';

const PREFIX = config.network === 'mainnet' ? 'bitcoincash' : 'bchtest';

// Accepts "bitcoincash:q...", "q...", "bitcoincash:z..." (token-aware), etc.
// Returns { address, tokenAddress, lockingBytecodeHex } or null if invalid.
export function normalizeAddress(input) {
  let s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  if (!s.includes(':')) s = `${PREFIX}:${s}`;
  const decoded = cashAddressToLockingBytecode(s.toLowerCase());
  if (typeof decoded === 'string' || decoded.prefix !== PREFIX) return null;

  const plain = lockingBytecodeToCashAddress({ bytecode: decoded.bytecode, prefix: PREFIX, tokenSupport: false });
  const token = lockingBytecodeToCashAddress({ bytecode: decoded.bytecode, prefix: PREFIX, tokenSupport: true });
  if (typeof plain === 'string' || typeof token === 'string') return null;
  return {
    address: plain.address,
    tokenAddress: token.address,
    lockingBytecodeHex: binToHex(decoded.bytecode),
  };
}

// Electrum "script hash": sha256 of the locking bytecode, byte-reversed, hex.
export function scripthashOf(address) {
  const a = normalizeAddress(address);
  if (!a) return null;
  return binToHex(sha256.hash(hexToBin(a.lockingBytecodeHex)).reverse());
}

export function shortAddress(addr) {
  const body = addr.split(':').pop();
  return `${body.slice(0, 6)}…${body.slice(-4)}`;
}
