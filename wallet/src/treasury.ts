// A Slot's Treasury (BIP300's CTIP), looked up on the wallet's own L1 Esplora by the strict
// exactly-one rule (#15, #31): no enforcer, no Sidechain Server.
//
// The enforcer rejects any block that creates a second Treasury for an active Slot, or one that
// doesn't spend the last. So among the unspent outputs to the Slot's Treasury script, the wallet
// accepts exactly one chain of Treasuries: rooted in a confirmed output whose transaction is M5- or
// M6-shaped, and followed through pending M5s to the unspent end. Anything it can't place is a
// refusal, never a guess: a wrong pick only makes an invalid M5, and the module reads the value
// from the transaction itself, never from what the server says about it.
import type { EsploraClient, EsploraTx } from "./esplora";

/**
 * The Treasury to spend, or none: the Slot has never been funded (or isn't active). `unconfirmed`:
 * it is a pending M5's, so an M5 spending it may be at most 1,000 vB (Backbone's `dc-unconfirmed-parent`).
 */
export type Treasury = { txid: string; vout: number; unconfirmed: boolean } | undefined;

/** How many pending M5s in a row the wallet follows (Bitcoin Core's ancestor limit). */
const MAX_PENDING = 25;

/** The Treasury can't be determined; `message` says why. */
export class TreasuryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreasuryError";
  }
}

/** The data of an `OP_RETURN` with exactly one push (the enforcer's `try_parse_op_return_address`). */
function isSinglePushOpReturn(script: string): boolean {
  const bytes = script.match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
  if (bytes[0] !== 0x6a || bytes.length < 2) return false;
  const op = bytes[1];
  const [header, length] =
    op <= 0x4b ? [1, op] : op === 0x4c ? [2, bytes[2]] : op === 0x4d ? [3, bytes[2] | (bytes[3] << 8)] : op === 0x4e ? [5, bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)] : [0, -1];
  return length >= 0 && 1 + header + length === bytes.length;
}

/** An M5 creates its Treasury output directly before a single-push `OP_RETURN` (its address). */
export const isM5 = (tx: EsploraTx, vout: number) => tx.vout[vout + 1] !== undefined && isSinglePushOpReturn(tx.vout[vout + 1].scriptpubkey);

/** An M6 has one input (the Treasury it pays out of) and creates the new Treasury as output 0. */
const isM6 = (tx: EsploraTx, vout: number) => tx.vin.length === 1 && vout === 0;

const key = ({ txid, vout }: { txid: string; vout: number }) => `${txid}:${vout}`;

async function sha256(hex: string): Promise<string> {
  const bytes = new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Slot's Treasury on `client`'s chain: `script` is its Treasury script (hex), from the L1
 * module. Throws TreasuryError when it can't be determined.
 */
export async function findTreasury(client: EsploraClient, script: string, slot: number): Promise<Treasury> {
  const cant = (why: string) => new TreasuryError(`Can't determine Slot ${slot}'s Treasury: ${why}`);
  const utxos = await client.scripthashUtxos(await sha256(script));

  /** Each Treasury chain's confirmed root → the unspent ends that trace back to it. */
  const chains = new Map<string, Set<string>>();
  for (const utxo of utxos) {
    let tx = await client.tx(utxo.txid);
    if (tx.vout[utxo.vout]?.scriptpubkey !== script) throw cant(`${client.url} listed an output that doesn't pay its Treasury script.`);
    let at = { txid: utxo.txid, vout: utxo.vout };
    if (utxo.confirmed) {
      // A confirmed output of another shape was paid to the script, never created by an M5 or M6: not a Treasury.
      if (!isM5(tx, at.vout) && !isM6(tx, at.vout)) continue;
    } else {
      // Unconfirmed and not an M5: a stray payment no enforcing node would mine.
      if (!isM5(tx, at.vout)) continue;
      for (let depth = 0; !tx.status.confirmed; depth++) {
        if (depth === MAX_PENDING) throw cant(`more than ${MAX_PENDING} Deposits to it are pending.`);
        if (!isM5(tx, at.vout)) throw cant(`a pending transaction spends it without being a Deposit.`);
        const spent = tx.vin.find((input) => input.prevout?.scriptpubkey === script);
        if (spent === undefined) throw cant("a first Deposit to it is pending. Try again once it confirms.");
        at = { txid: spent.txid, vout: spent.vout };
        tx = await client.tx(spent.txid);
      }
      if (!isM5(tx, at.vout) && !isM6(tx, at.vout)) throw cant("a pending Deposit spends an output that was never a Treasury.");
    }
    const root = key(at);
    chains.set(root, (chains.get(root) ?? new Set()).add(key(utxo)));
  }

  if (chains.size === 0) return undefined;
  if (chains.size > 1) throw cant(`${client.url} shows ${chains.size} Treasuries, and a Slot has only one.`);
  const [ends] = chains.values();
  if (ends.size > 1) throw cant(`${client.url} shows ${ends.size} pending Treasuries spending the same one.`);
  const [[root, [end]]] = [...chains].map(([root, ends]) => [root, [...ends]] as const);
  const [txid, vout] = end.split(":");
  return { txid, vout: Number(vout), unconfirmed: end !== root };
}
