// Connects to the payer's wallet with WizardConnect, builds the payment, and asks the wallet to sign it.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, stringify, binToHex } from '@bitauth/libauth';
import { buildPayment } from '../shared/tx.js';

const PATHS = [{ name: 'receive', child: 0 }, { name: 'change', child: 1 }];
const GAP = 20;

export class WalletSession {
  constructor({ prefix = 'bitcoincash', onDisconnect } = {}) {
    this.prefix = prefix;
    this.mgr = new DappConnectionManager('Payday', `${location.origin}/icon.png`, { session: false });
    this.relay = initiateDappRelay((p) => this.mgr.updateConnection(p.client, p.status));
    this.mgr.attachRelay(this.relay);
    this.mgr.on('disconnect', () => onDisconnect?.());
    this.uri = this.relay.uri;
    this.qrUri = this.relay.qrUri;
  }

  // Resolves when the wallet has scanned the QR and shared its public keys.
  waitForWallet() {
    if (this.mgr.isWalletDiscovered()) return Promise.resolve(this.mgr.walletName);
    return new Promise((resolve) => this.mgr.once('walletready', (msg) => resolve(msg?.wallet_name || this.mgr.walletName || 'your wallet')));
  }

  addressAt(child, index) {
    const pk = this.mgr.getPubkey(child, BigInt(index));
    if (!pk) return null;
    const bytecode = encodeLockingBytecodeP2pkh(hash160(pk));
    const res = lockingBytecodeToCashAddress({ bytecode, prefix: this.prefix });
    return { address: typeof res === 'string' ? res : res.address, bytecode };
  }

  // Finds the wallet's coins: first 20 receive + 20 change addresses.
  async scan() {
    const slots = [];
    for (const p of PATHS) {
      for (let i = 0; i < GAP; i++) {
        const a = this.addressAt(p.child, i);
        if (a) slots.push({ ...a, path: p.name, index: i });
      }
    }
    if (!slots.length) throw new Error('The wallet did not share its addresses. Please reconnect.');
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
    return (this.addressAt(1, 0) || this.addressAt(0, 0)).bytecode;
  }

  // Builds the payment, asks the wallet to sign it, returns the signed transaction hex.
  async signPayment({ utxos, method, payeeLockingBytecode, amountSats, tokenAmount, tokenCategory, invoiceId, prompt }) {
    const built = buildPayment({
      utxos, method, payeeLockingBytecode, amountSats, tokenAmount, tokenCategory,
      changeLockingBytecode: this.changeBytecode(), invoiceId,
    });
    const res = await this.mgr.signTransaction({
      transaction: {
        transaction: built.hex,
        // The relay speaks JSON: libauth's extended-JSON keeps bigint / bytes intact.
        sourceOutputs: JSON.parse(stringify(built.sourceOutputs)),
        userPrompt: prompt,
        broadcast: false,
      },
      inputPaths: built.inputPaths,
    });
    if (res?.error) throw new Error(res.error);
    const signed = typeof res.signedTransaction === 'string' ? res.signedTransaction : binToHex(res.signedTransaction);
    if (!signed) throw new Error('The wallet did not return a signed payment.');
    return signed;
  }

  async close() {
    try { await this.mgr.sendDisconnect('Payment finished'); } catch { /* ignore */ }
    try { await this.mgr.destroy(); } catch { /* ignore */ }
    try { this.relay.cleanup(); } catch { /* ignore */ }
  }
}
