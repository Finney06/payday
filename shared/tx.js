// Builds an unsigned Bitcoin Cash payment for an invoice. Used in the browser (pay page)
// and in tests. Pure functions: no network, no keys.
import {
  encodeTransaction, hexToBin, binToHex, encodeDataPush, utf8ToBin,
} from '@bitauth/libauth';

export const TOKEN_DUST = 1000n;   // sats carried by each token output
export const DUST = 546n;          // smallest normal BCH output
const P2PKH_UNLOCK_SIZE = 107;     // signature + public key, for fee estimates
const FEE_RATE = 1.1;              // sats per byte (network minimum is 1)

export function opReturnInvoice(invoiceId) {
  return Uint8Array.from([0x6a, ...encodeDataPush(utf8ToBin('PAYDAY')), ...encodeDataPush(utf8ToBin(invoiceId))]);
}

function toLibauthOutput({ lockingBytecode, valueSatoshis, token }) {
  const out = { lockingBytecode, valueSatoshis };
  if (token) out.token = { amount: token.amount, category: hexToBin(token.category) };
  return out;
}

function estimateFee(inputs, outputs) {
  const tx = {
    version: 2, locktime: 0,
    inputs: inputs.map((u) => ({
      outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0,
      unlockingBytecode: new Uint8Array(P2PKH_UNLOCK_SIZE),
    })),
    outputs: outputs.map(toLibauthOutput),
  };
  return BigInt(Math.ceil(encodeTransaction(tx).length * FEE_RATE));
}

/**
 * @param o.utxos  [{ txid, vout, value: bigint, token: {category, amount: bigint, nft}|null, lockingBytecode, path, index }]
 * @param o.method 'BCH' | 'PUSD'
 * @param o.payeeLockingBytecode Uint8Array
 * @param o.amountSats bigint   (BCH method)
 * @param o.tokenAmount bigint  (PUSD method, in token units = cents)
 * @param o.tokenCategory hex   (PUSD category)
 * @param o.changeLockingBytecode Uint8Array
 * @param o.invoiceId string
 */
export function buildPayment(o) {
  const outputs = [];
  const chosen = [];
  let tokenIn = 0n;

  if (o.method === 'PUSD') {
    const tokenUtxos = o.utxos
      .filter((u) => u.token && u.token.category === o.tokenCategory && !u.token.nft)
      .sort((a, b) => (b.token.amount > a.token.amount ? 1 : -1));
    for (const u of tokenUtxos) {
      if (tokenIn >= o.tokenAmount) break;
      chosen.push(u); tokenIn += u.token.amount;
    }
    if (tokenIn < o.tokenAmount) {
      const have = Number(tokenIn) / 100;
      throw new PaymentError('NOT_ENOUGH_PUSD', `Your wallet has ${have.toFixed(2)} ParyonUSD, but this invoice needs ${(Number(o.tokenAmount) / 100).toFixed(2)}.`);
    }
    outputs.push({ lockingBytecode: o.payeeLockingBytecode, valueSatoshis: TOKEN_DUST, token: { category: o.tokenCategory, amount: o.tokenAmount } });
    if (tokenIn > o.tokenAmount) {
      outputs.push({ lockingBytecode: o.changeLockingBytecode, valueSatoshis: TOKEN_DUST, token: { category: o.tokenCategory, amount: tokenIn - o.tokenAmount } });
    }
  } else {
    if (o.amountSats < DUST) throw new PaymentError('TOO_SMALL', 'This amount is too small to send in BCH. Try paying with ParyonUSD.');
    outputs.push({ lockingBytecode: o.payeeLockingBytecode, valueSatoshis: o.amountSats });
  }
  outputs.push({ lockingBytecode: opReturnInvoice(o.invoiceId), valueSatoshis: 0n });

  // Fund with plain BCH coins (never spend coins that carry tokens we aren't sending).
  const bchUtxos = o.utxos.filter((u) => !u.token).sort((a, b) => (b.value > a.value ? 1 : -1));
  const outTotal = () => outputs.reduce((s, x) => s + x.valueSatoshis, 0n);
  const inTotal = () => chosen.reduce((s, u) => s + u.value, 0n);
  const changeOut = { lockingBytecode: o.changeLockingBytecode, valueSatoshis: 0n };

  let i = 0;
  for (;;) {
    const fee = estimateFee(chosen, [...outputs, changeOut]);
    const spare = inTotal() - outTotal() - fee;
    if (spare >= 0n && chosen.length) {
      if (spare >= DUST) outputs.push({ ...changeOut, valueSatoshis: spare });
      break;
    }
    if (i >= bchUtxos.length) {
      const needBch = Number(outTotal() + fee - inTotal()) / 1e8;
      throw new PaymentError('NOT_ENOUGH_BCH',
        o.method === 'PUSD'
          ? `You need a tiny bit of BCH for the network fee (about ${needBch.toFixed(6)} BCH). Please add a little BCH to your wallet.`
          : `Your wallet doesn't have enough BCH for this payment (short by about ${needBch.toFixed(6)} BCH).`);
    }
    chosen.push(bchUtxos[i++]);
  }

  const inputs = chosen.map((u) => ({
    outpointTransactionHash: hexToBin(u.txid), outpointIndex: u.vout, sequenceNumber: 0, unlockingBytecode: new Uint8Array(),
  }));
  const libOutputs = outputs.map(toLibauthOutput);
  const tx = { version: 2, locktime: 0, inputs, outputs: libOutputs };

  const sourceOutputs = chosen.map((u, n) => ({
    ...inputs[n],
    lockingBytecode: u.lockingBytecode,
    valueSatoshis: u.value,
    ...(u.token ? { token: { amount: u.token.amount, category: hexToBin(u.token.category) } } : {}),
  }));

  return {
    hex: binToHex(encodeTransaction(tx)),
    sourceOutputs,
    inputPaths: chosen.map((u, n) => [n, u.path, u.index]),
    fee: inTotal() - outputs.reduce((s, x) => s + x.valueSatoshis, 0n),
  };
}

export class PaymentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
