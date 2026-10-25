// The pull path (spec #18, stories 14-20): the wallet talks to a chain's Sidechain Server, the one
// its Chain Entry names for the network the Chain Module serves, in the Server API it names: a
// Slot's, or eCash's own (#30; it reads state only, Send on L1 comes with Deposit, #31). The
// wallet derives the addresses it watches (the server never hands any out), shows the state the
// server reports, and sends by having the server build a Signing Request that then takes the same
// review as any other.
import { createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import { NATIVE_COIN, type AssetAmount, type ChainEntry, type ChainKey, type ClearView, type NetworkEntry, type Starter } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import { SidechainServerError, type HistoryEntry, type SidechainServer, type TransferOrder, type TreasuryScript, type WatchData } from "./sidechain-server";
import { parseSigningRequest, type SigningRequest } from "./signing-request";
import { chainModuleFor, reviewAndSign, type SigningApproval, type SigningDeps } from "./signing";

/** Receive addresses the wallet watches: the gap a server watches ahead of the first unused one. */
export const WATCHED_RECEIVE_ADDRESSES = 20;
/** Change addresses the wallet watches, for servers that only see addresses (Esplora). */
export const WATCHED_CHANGE_ADDRESSES = 20;

export interface PullPathDeps extends SigningDeps, Keys, ChainModules {
  /** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
  sidechainServer(entry: ChainEntry, network: NetworkEntry): SidechainServer;
  /** Where the last reported balances are kept for the session, to show while refreshing. */
  cache?: SessionCache;
}

/** A chain with its Chain Module, its key and the Sidechain Server it talks to. */
type ChainServer<K extends ChainKey> = KeyedChain<K> & { server: SidechainServer };

/** A chain's balance as its Sidechain Server reports it. */
export interface ChainReport {
  chain: string;
  /** Who reported it. */
  server: string;
  balances: AssetAmount[];
  /** What's on its way in, unconfirmed: shown apart, never spent. */
  unconfirmed: AssetAmount[];
  /** Tokens only the server vouches for (Flush's result outputs, docs/adr/0013): shown apart, never spent. */
  unverified?: AssetAmount[];
  /** When the chain's last block was mined (seconds since the epoch), if it has stalled. */
  stalledSince?: number;
  /** When the server reported it, in milliseconds since the epoch. */
  readAt: number;
}

/** A chain's transactions as its Sidechain Server reports them, newest first. */
export interface ChainHistory {
  chain: string;
  /** Who reported it. */
  server: string;
  entries: HistoryEntry[];
  /** The server has older transactions it didn't list. */
  partial: boolean;
  /** When the server reported it, in milliseconds since the epoch. */
  readAt: number;
}

/** A Slot's balance as its Sidechain Server reports it. */
export interface SlotReport extends ChainReport {
  slot: number;
}

/** A Send that went out: broadcast by the wallet, or accepted by the Sidechain Server that built it. */
export interface SendResult {
  /** Who built or broadcast it. */
  server: string;
  accepted: boolean;
  txid?: string;
}

/** The order with its addresses trimmed; refuses one without outputs or with an unusable one. */
export function checkedOrder(order: TransferOrder): TransferOrder {
  const outputs = Array.isArray(order?.outputs) ? order.outputs : [];
  if (outputs.length === 0) throw new ProviderRpcError(ErrorCode.InvalidParams, "Add at least one recipient.");
  return {
    outputs: outputs.map(({ asset, amount, to }, i) => {
      const which = outputs.length > 1 ? ` (recipient ${i + 1})` : "";
      if (typeof asset !== "string" || !(asset === NATIVE_COIN || /^[0-9a-f]{64}$/.test(asset))) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `Choose an asset${which}.`);
      }
      if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `The amount must be a whole number of base units${which}.`);
      }
      const kinds = to !== null && typeof to === "object" ? Object.keys(to).filter((k) => k !== "address") : [];
      if (kinds.length > 0) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `This wallet can only pay an address (\`to: { address }\`), not \`${kinds.join(", ")}\`${which}.`);
      }
      const address = typeof to?.address === "string" ? to.address.trim() : "";
      if (address === "") throw new ProviderRpcError(ErrorCode.InvalidParams, `Enter a destination address${which}.`);
      return { asset, amount, to: { address } };
    }),
  };
}

/**
 * Whether a Clear View is the transfer `order` asked for: the payments first, in order, then only
 * outputs back to the wallet.
 */
export function isTransferAskedFor(view: ClearView, order: TransferOrder): boolean {
  const paid = view.outputs.slice(0, order.outputs.length);
  const matches = order.outputs.every(({ asset, amount, to }, i) => {
    const out = paid[i];
    return out?.asset === asset && out.amount === amount && out.destination.kind === "address" && out.destination.address.toLowerCase() === to.address.toLowerCase();
  });
  const rest = view.outputs.slice(order.outputs.length).every((o) => o.destination.kind === "address" && o.destination.yours);
  return matches && rest;
}

/** Why a server-built request that needs Blind Signing is refused: there is no Grant to opt in. */
const BLIND_REFUSED =
  "The wallet can't fully explain the transaction the Sidechain Server built, so it won't sign it: " +
  "a Sidechain Server's request must be Clear Signed.";

export function createPullPath(deps: PullPathDeps) {
  const routing = createKeyRouting(deps);

  /** The chain's Sidechain Server: its Chain Entry's default for the network its module serves. */
  function withServer<K extends ChainKey>(target: KeyedChain<K>): ChainServer<K> {
    return { ...target, server: deps.sidechainServer(target.entry, target.network) };
  }

  /** The chain's watch data, derived from its key by its Chain Module. */
  async function watch<K extends ChainKey>({ module, chain, key }: ChainServer<K>): Promise<WatchData> {
    const { descriptor, receive, change } = module.deriveAccount(await key(), {
      receive: WATCHED_RECEIVE_ADDRESSES,
      change: WATCHED_CHANGE_ADDRESSES,
    });
    return { chain, descriptor, receive, change };
  }

  async function reported<K extends ChainKey>(target: ChainServer<K>): Promise<ChainReport> {
    const { chain, server } = target;
    const { balances, unconfirmed, unverified, stalledSince } = await server.state(await watch(target));
    const report = {
      chain,
      server: server.url,
      balances,
      unconfirmed,
      ...(unverified === undefined ? {} : { unverified }),
      ...(stalledSince === undefined ? {} : { stalledSince }),
      readAt: deps.now(),
    };
    await deps.cache?.set(cacheKey.balance(chain, server.url), report);
    return report;
  }

  async function history<K extends ChainKey>(target: ChainServer<K>, treasuries?: TreasuryScript[]): Promise<ChainHistory> {
    const { chain, server } = target;
    const { entries, partial } = await server.history(await watch(target), treasuries);
    const reported = { chain, server: server.url, entries, partial, readAt: deps.now() };
    await deps.cache?.set(cacheKey.history(chain, server.url), reported);
    return reported;
  }

  /** The last report from the chain's current server this session, if any. Derives no key. */
  async function cached<K extends ChainKey>({ chain, server }: ChainServer<K>): Promise<ChainReport | undefined> {
    return deps.cache?.get<ChainReport>(cacheKey.balance(chain, server.url));
  }

  /** The last history from the chain's current server this session, if any. Derives no key. */
  async function cachedHistory<K extends ChainKey>({ chain, server }: ChainServer<K>): Promise<ChainHistory | undefined> {
    return deps.cache?.get<ChainHistory>(cacheKey.history(chain, server.url));
  }

  return {
    /** What the Slot's server reports for the addresses the wallet watches. */
    async reportedState(slot: number): Promise<SlotReport> {
      return { slot, ...(await reported(withServer(await routing.slot(slot)))) };
    },

    /** What eCash's server reports for the L1 addresses the wallet watches. */
    async reportedL1State(): Promise<ChainReport> {
      return reported(withServer(await routing.l1()));
    },

    /** The Slot's last reported state this session, to show while `reportedState` refreshes it. */
    async cachedState(slot: number): Promise<SlotReport | undefined> {
      const report = await cached(withServer(await routing.slot(slot)));
      return report && { slot, ...report };
    },

    /** eCash's last reported state this session, to show while `reportedL1State` refreshes it. */
    cachedL1State: async (): Promise<ChainReport | undefined> => cached(withServer(await routing.l1())),

    /** The transactions the Slot's server reports for the addresses the wallet watches. */
    history: async (slot: number): Promise<ChainHistory> => history(withServer(await routing.slot(slot))),

    /** The transactions eCash's server reports for the L1 addresses the wallet watches; Deposits to a Slot it supports labelled. */
    async l1History(): Promise<ChainHistory> {
      const l1 = await routing.l1();
      return history(withServer(l1), deps.supportedSlots.map((slot) => ({ slot, scriptPubkey: l1.module.treasuryScript(slot) })));
    },

    /** The Slot's last reported history this session, to show while `history` refreshes it. */
    cachedHistory: async (slot: number): Promise<ChainHistory | undefined> => cachedHistory(withServer(await routing.slot(slot))),

    /** eCash's last reported history this session, to show while `l1History` refreshes it. */
    cachedL1History: async (): Promise<ChainHistory | undefined> => cachedHistory(withServer(await routing.l1())),

    /**
     * The wallet's own Send: the Slot's server builds the transfer; the Signing Request it returns
     * gets the whole validation order (no Grant step: the wallet asked for it), must be Clear (no
     * Grant, so no Blind opt-in) and be the transfer asked for, is approved in the approval window
     * naming the server, then signed and submitted back. A Sidechain App's Send (`via`) names the
     * app instead, in the window it already opened.
     */
    async send(slot: number, order: TransferOrder, via?: { requester: string; approval: SigningApproval }): Promise<SendResult> {
      const checked = checkedOrder(order);
      const target: ChainServer<Starter> = withServer(await routing.slot(slot));
      const { server } = target;
      const watched = await watch(target);
      const built = await server.buildTransfer(watched, checked);

      // From here, whatever is wrong with the request is the server's doing: the requester reads it
      // as the server's error, not its own (only rejecting stays the user's).
      let request: SigningRequest;
      let signed: string;
      try {
        request = parseSigningRequest(built, Math.floor(deps.now() / 1000));
        if (request.slot !== slot) {
          throw new ProviderRpcError(ErrorCode.InvalidParams, `Slot ${slot}'s Sidechain Server sent a request for ${request.chain}.`);
        }
        const module = await chainModuleFor(deps, request);
        signed = await reviewAndSign(deps, {
          requester: via?.requester ?? server.url,
          request,
          module,
          blindRefusal: BLIND_REFUSED,
          approval: via?.approval,
          expect: (view) => {
            if (!isTransferAskedFor(view, checked)) {
              throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} built a transfer that isn't the one asked for. Nothing was sent.`);
            }
          },
        });
      } catch (error) {
        if (error instanceof ProviderRpcError && error.code !== ErrorCode.UserRejected) throw new SidechainServerError(server.url, error.message);
        throw error;
      }
      const { accepted, txid } = await server.submit(watched, request.id, signed);
      return { server: server.url, accepted, ...(txid ? { txid } : {}) };
    },
  };
}

export type PullPath = ReturnType<typeof createPullPath>;
export type { TransferOrder };
