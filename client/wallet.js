// Connects to the payer's wallet with WizardConnect, builds the payment, and asks the wallet to sign it.
// The pairing is saved for this invoice, because phones often reload the page while the payer is in the wallet app.
import {
  initiateRelay, RelayStatus, RelayMsgAction, generateKeyExchangeCredentials, encodeKeyExchangeURI, DEFAULT_RELAY_URLS,
} from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import {
  hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, stringify, binToHex, hexToBin,
  decodeHdPublicKey, decodeHdKeyUnchecked, deriveHdPublicNodeChild,
} from '@bitauth/libauth';
import { buildPayment } from '../shared/tx.js';

// Wallets name and encode their address chains a little differently, so read each chain the wallet shares.
// Returns [{ name, child, node }]: name is the wallet's own name (sent back when signing), child 0 = receive, 1 = change.
export function readChains(paths = []) {
  const chains = [];
  const problems = [];
  for (const p of paths) {
    let decoded = decodeHdPublicKey(p.xpub);
    if (typeof decoded === 'string') {
      const loose = decodeHdKeyUnchecked(p.xpub);
      if (typeof loose !== 'string' && loose.node.publicKey) decoded = loose;
    }
    if (typeof decoded === 'string') { problems.push(`${p.name}: ${decoded}`); continue; }
    const n = String(p.name).toLowerCase();
    if (/defi|cauldron|stealth|rpa/.test(n)) continue;
    let child = /receiv|extern|main|deposit|^0$/.test(n) ? 0 : /change|intern|^1$/.test(n) ? 1 : undefined;
    let node = decoded.node;
    // An account-level key (m/44'/145'/0') still needs the receive or change step.
    if (node.depth === 3) {
      const step = deriveHdPublicNodeChild(node, child ?? chains.length);
      if (typeof step === 'string') { problems.push(`${p.name}: ${step}`); continue; }
      node = step;
    }
    chains.push({ name: p.name, child, node });
  }
  // Unnamed chains: the first is receive, the next is change.
  for (const c of chains) {
    if (c.child !== undefined) continue;
    c.child = [0, 1].find((k) => !chains.some((o) => o.child === k)) ?? 0;
  }
  return { chains, problems };
}
const GAP = 20;
const PAIRING_TTL = 20 * 60 * 1000;
const CLOCK_MARGIN = 60; // seconds, in case the wallet's clock differs from this device's
const pairingKey = (invoiceId) => `payday-pairing:${invoiceId}`;

export function forgetPairing(invoiceId) {
  try { localStorage.removeItem(pairingKey(invoiceId)); } catch { /* storage unavailable */ }
}

export function loadPairing(invoiceId) {
  try {
    const p = JSON.parse(localStorage.getItem(pairingKey(invoiceId)));
    if (p?.credentials?.privateKey && p.credentials.publicKey && p.credentials.secret && Date.now() - p.savedAt < PAIRING_TTL) return p;
  } catch { /* storage unavailable or damaged: start fresh */ }
  forgetPairing(invoiceId);
  return null;
}

export class WalletSession {
  constructor({ prefix = 'bitcoincash', invoiceId, method, onDisconnect } = {}) {
    this.prefix = prefix;
    this.invoiceId = invoiceId;
    const saved = loadPairing(invoiceId);
    this.resumed = Boolean(saved);
    this.pairing = saved || { credentials: generateKeyExchangeCredentials(), startedAt: Math.floor(Date.now() / 1000), method };
    this.savePairing();

    this.mgr = new DappConnectionManager('Payday', `${location.origin}/icon.png`, { session: false });
    this.mgr.on('disconnect', () => onDisconnect?.());
    this.mgr.on('messagereceived', (msg) => this.onMessage(msg));
    this.mgr.on('walletready', (msg) => this.rememberWallet(msg));
    const wallet = this.pairing.wallet;
    if (wallet?.paths?.length) {
      try { this.mgr.restoreSessionPaths(wallet.paths); } catch { /* readChains reads the saved paths itself */ }
    }

    const { publicKey, secret, privateKey } = this.pairing.credentials;
    const { uri, qrUri } = encodeKeyExchangeURI(publicKey, secret);
    this.uri = uri;
    this.qrUri = qrUri;
    this.stopRelay = initiateRelay((p) => this.mgr.updateConnection(p.client, p.status), hexToBin(privateKey), wallet?.publicKey ? hexToBin(wallet.publicKey) : new Uint8Array(33), {
      explicitRelayUrls: [...DEFAULT_RELAY_URLS],
      pairingSecret: secret,
      onClient: (client) => {
        // Read what the wallet sent during a reload. Relays may replay messages newest first, so start
        // from the signing request when there is one: older messages must not hide the wallet's answer.
        client.setLastProcessedTimestamp((this.pairing.signRequestedAt ?? this.pairing.startedAt) - CLOCK_MARGIN);
        this.mgr.updateConnection(client, RelayStatus.disconnected());
      },
    });
  }

  savePairing() {
    try {
      localStorage.setItem(pairingKey(this.invoiceId), JSON.stringify({ ...this.pairing, savedAt: Date.now() }));
    } catch { /* the payment still works unless the page reloads */ }
  }

  markCopied() {
    this.pairing.copied = true;
    this.savePairing();
  }

  get linkCopied() { return Boolean(this.pairing.copied); }
  get hasPendingSignature() { return this.pairing.sequence !== undefined; }

  rememberWallet(msg) {
    this.pairing.wallet = {
      publicKey: msg?.public_key || this.walletPublicKey || this.pairing.wallet?.publicKey,
      name: msg?.wallet_name || this.mgr.walletName || 'your wallet',
      paths: this.mgr.getSessionPaths(),
    };
    this.savePairing();
  }

  onMessage(msg) {
    if (msg.action === RelayMsgAction.WalletReady) this.walletPublicKey = msg.public_key;
    if (msg.action !== RelayMsgAction.SignTransactionResponse || msg.sequence !== this.pairing.sequence) return;
    this.signatureResponse = msg;
    this.settleSignature?.(msg);
  }

  // Resolves when the wallet has connected and shared its public keys.
  waitForWallet() {
    if (this.pairing.wallet?.paths?.length) return Promise.resolve(this.pairing.wallet.name);
    if (this.mgr.isWalletDiscovered()) return Promise.resolve(this.mgr.walletName);
    return new Promise((resolve) => this.mgr.once('walletready', (msg) => resolve(msg?.wallet_name || this.mgr.walletName || 'your wallet')));
  }

  sharedPaths() {
    const live = this.mgr.getSessionPaths();
    return live.length ? live : (this.pairing.wallet?.paths || []);
  }

  chains() {
    return readChains(this.sharedPaths()).chains;
  }

  addressAt(chain, index) {
    const step = deriveHdPublicNodeChild(chain.node, index);
    if (typeof step === 'string') return null;
    const bytecode = encodeLockingBytecodeP2pkh(hash160(step.publicKey));
    const res = lockingBytecodeToCashAddress({ bytecode, prefix: this.prefix });
    return { address: typeof res === 'string' ? res : res.address, bytecode };
  }

  // Some wallets send their keys a moment after saying they are ready: wait up to 8 seconds for them.
  async waitForChains() {
    for (let t = 0; t < 16 && !this.chains().length; t++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.chains();
  }

  // Finds the wallet's coins: first 20 addresses on each chain the wallet shares.
  async scan() {
    const chains = await this.waitForChains();
    const slots = [];
    for (const c of chains) {
      for (let i = 0; i < GAP; i++) {
        const a = this.addressAt(c, i);
        if (a) slots.push({ ...a, path: c.name, index: i });
      }
    }
    if (!slots.length) {
      const paths = this.sharedPaths();
      const { problems } = readChains(paths);
      const detail = paths.length
        ? `shared: ${paths.map((p) => `${p.name} (${String(p.xpub).slice(0, 4)}…)`).join(', ')}${problems.length ? `; ${problems.join('; ')}` : ''}`
        : 'no addresses shared';
      console.warn('[payday] wallet paths', paths);
      throw new Error(`The wallet did not share its addresses. Please reconnect. (${detail})`);
    }
    const res = await fetch('/api/utxos', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: slots.map((s) => s.address) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not check your wallet balance.');
    const utxos = [];
    for (const s of slots) {
      for (const u of data[s.address] || []) {
        utxos.push({
          txid: u.txid, vout: u.vout, value: BigInt(u.value),
          token: u.token ? { category: u.token.category, amount: BigInt(u.token.amount), nft: u.token.nft } : null,
          lockingBytecode: s.bytecode, path: s.path, index: s.index,
        });
      }
    }
    return utxos;
  }

  changeBytecode() {
    const chains = this.chains();
    const chain = chains.find((c) => c.child === 1) || chains[0];
    return this.addressAt(chain, 0).bytecode;
  }

  // Waits for the wallet's answer to the saved request, including one sent while the page was reloading.
  waitForSignature() {
    return new Promise((resolve, reject) => {
      this.rejectSignature = reject;
      this.settleSignature = (msg) => {
        if (msg.error) { reject(new Error(msg.error)); return; }
        const signed = typeof msg.signedTransaction === 'string' ? msg.signedTransaction : binToHex(msg.signedTransaction);
        if (signed) resolve(signed);
        else reject(new Error('The wallet did not return a signed payment.'));
      };
      if (this.signatureResponse) this.settleSignature(this.signatureResponse);
    });
  }

  // Builds the payment, asks the wallet to sign it, returns the signed transaction hex.
  async signPayment({ utxos, method, payeeLockingBytecode, amountSats, tokenAmount, tokenCategory, invoiceId, prompt }) {
    const built = buildPayment({
      utxos, method, payeeLockingBytecode, amountSats, tokenAmount, tokenCategory,
      changeLockingBytecode: this.changeBytecode(), invoiceId,
    });
    const sequence = this.mgr.nextSequence();
    this.pairing.method = method;
    this.pairing.sequence = sequence;
    this.pairing.signRequestedAt = Math.floor(Date.now() / 1000);
    this.savePairing();
    const signature = this.waitForSignature();
    this.mgr.sendSignRequest({
      action: RelayMsgAction.SignTransactionRequest,
      time: Math.floor(Date.now() / 1000),
      sequence,
      transaction: {
        transaction: built.hex,
        // The relay speaks JSON: libauth's extended-JSON keeps bigint / bytes intact.
        sourceOutputs: JSON.parse(stringify(built.sourceOutputs)),
        userPrompt: prompt,
        broadcast: false,
      },
      inputPaths: built.inputPaths,
    }).catch((err) => this.rejectSignature?.(err));
    return signature;
  }

  async close() {
    forgetPairing(this.invoiceId);
    try { await this.mgr.sendDisconnect('Payment finished'); } catch { /* ignore */ }
    try { await this.mgr.destroy(); } catch { /* ignore */ }
    try { this.stopRelay(); } catch { /* ignore */ }
  }
}
