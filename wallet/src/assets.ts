// The assets the wallet names beyond its Chain Entries (docs/adr/0010): one store per network, in
// persistent storage and not encrypted, like Grants. A screen looks an asset up in the Chain Entry
// first, then here, and says where a stored name came from: the asset's own contract, an app the
// user approved it from, or the user.
import { ErrorCode, ProviderRpcError } from "./errors";
import { ChainModuleRefusal, type AssetEntry, type ChainModule, type ClearView } from "./chain-module";
import type { EsploraClient } from "./esplora";
import type { KeyValueStore } from "./vault";

/**
 * Where a stored asset's name came from: `signed`, a new issuance the wallet signed whose contract
 * evidence checked out; `contract`, a contract checked against the chain (added by the user, or
 * suggested by an app and approved); `app`, a name an app suggested without a contract, which the
 * user approved; `label`, the user's own name for an asset with no contract.
 */
export type AssetSource = "signed" | "contract" | "app" | "label";

export interface StoredAsset {
  /** Lowercase display hex. */
  id: string;
  name: string;
  ticker: string;
  /** Places after the point in one whole unit. */
  precision: number;
  /** What the contract claims; never checked. */
  domain?: string;
  /** The contract's exact JSON, when the asset was added by it. */
  contract?: string;
  source: AssetSource;
  /** The app that suggested it (`app`, or a `contract` an app suggested): its web origin. */
  origin?: string;
}

/** An asset as screens name it: its Chain Entry's word on it, or (with `source`) the store's. */
export interface NamedAsset extends AssetEntry {
  source?: AssetSource;
  domain?: string;
  origin?: string;
}

/** A name an app suggests for an asset (`suggestAsset`): by its contract, or as a plain name. */
export interface AssetSuggestion {
  asset: string;
  /** The contract's exact JSON, checked against the chain before the user sees it. */
  contract?: string;
  /** A name for an asset with no contract, held to a label's rules. */
  label?: Pick<StoredAsset, "name" | "ticker" | "precision">;
}

export interface AssetsDeps {
  store: KeyValueStore;
  /** The assets the Chain Entry names on the network `chain` (CAIP-2) is. */
  entryAssets(chain: string): Promise<AssetEntry[]>;
}

const storeKey = (chain: string) => `assets:${chain}`;
const ID = /^[0-9a-f]{64}$/;
const refused = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);
/** A name the asset's own contract backs: only removing it makes room for another. */
const fromContract = (asset: StoredAsset | undefined) => asset?.source === "signed" || asset?.source === "contract";

/** An asset id as given, or refused. */
function assetId(asset: unknown): string {
  const id = String(asset ?? "").toLowerCase();
  if (!ID.test(id)) throw refused("An asset id is 64 hex digits.");
  return id;
}

/** A label's name and ticker, held to the registry's rules for a contract's (docs/adr/0009). */
function checkLabel({ name, ticker, precision }: Pick<StoredAsset, "name" | "ticker" | "precision">): void {
  if (typeof name !== "string" || !/^[\x20-\x7e]{1,255}$/.test(name)) throw refused("A label's name is 1 to 255 printable ASCII characters.");
  if (typeof ticker !== "string" || !/^[A-Za-z0-9.-]{3,24}$/.test(ticker)) throw refused("A label's ticker is 3 to 24 letters, digits, dots or hyphens.");
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) throw refused("A label's precision is 0 to 8 decimal places.");
}

export function createAssets({ store, entryAssets }: AssetsDeps) {
  async function stored(chain: string): Promise<Record<string, StoredAsset>> {
    return (await store.get<Record<string, StoredAsset>>(storeKey(chain))) ?? {};
  }

  /**
   * Throws unless `asset` may be stored: the Chain Entry doesn't name it, and its ticker isn't one
   * of the Chain Entry's on that network (in any case), so nothing shows as "ECX" but ECX.
   */
  async function admissible(chain: string, asset: StoredAsset): Promise<void> {
    const entry = await entryAssets(chain);
    const named = entry.find((a) => a.id === asset.id);
    if (named) throw refused(`This wallet already names asset ${asset.id}: it is ${named.ticker}.`);
    const taken = entry.find((a) => a.ticker.toLowerCase() === asset.ticker.toLowerCase());
    if (taken) throw refused(`The ticker ${asset.ticker} is taken: on this chain, only ${taken.name} shows as ${taken.ticker}.`);
  }

  /** Stores `asset` if admissible, replacing what the store had for it. */
  async function put(chain: string, asset: StoredAsset): Promise<StoredAsset> {
    await admissible(chain, asset);
    await store.set(storeKey(chain), { ...(await stored(chain)), [asset.id]: asset });
    return asset;
  }

  /**
   * `contract` (exact JSON), if it is `id`'s: the server says which outpoint its issuance spent, and
   * the Slot's module derives the asset id from that and the contract's hash, so the server can't
   * make another contract pass. `module` must declare `assetContract`; `client` is its network's
   * server, over Esplora.
   */
  async function checkedContract(module: ChainModule, client: EsploraClient, id: string, contract: unknown): Promise<StoredAsset> {
    const { binding, capabilities } = module.declare();
    if (!capabilities.includes("assetContract")) throw refused(`This wallet can't check contracts on ${binding.chain}.`);
    if (typeof contract !== "string") throw refused("A contract is its exact JSON, as a string.");
    await client.checkChain();
    const issuance = await client.assetIssuance(id);
    if (issuance === undefined) throw refused(`The Sidechain Server at ${client.url} doesn't know asset ${id} as one a transaction issued.`);
    try {
      const { name, ticker, precision, domain } = module.assetContract(id, issuance, contract);
      return { id, name, ticker, precision, domain, contract, source: "contract" };
    } catch (error) {
      if (error instanceof ChainModuleRefusal) throw refused(error.message);
      throw error;
    }
  }

  return {
    /** The assets screens name on `chain`: the Chain Entry's, then the store's for any other asset. */
    async named(chain: string): Promise<NamedAsset[]> {
      const entry = await entryAssets(chain);
      const extra = Object.values(await stored(chain)).filter((a) => !entry.some((e) => e.id === a.id));
      return [
        ...entry,
        ...extra.map(({ id, name, ticker, precision, domain, source, origin }) => ({
          id,
          name,
          ticker,
          decimals: precision,
          source,
          ...(domain === undefined ? {} : { domain }),
          ...(origin === undefined ? {} : { origin }),
        })),
      ];
    },

    /** Everything stored for `chain`. */
    list: async (chain: string): Promise<StoredAsset[]> => Object.values(await stored(chain)),

    /**
     * After the wallet signed `view` on `chain`: each new asset it issues whose contract evidence
     * checked out. One whose ticker collides is left unnamed; signing isn't undone for it.
     */
    async rememberSigned(chain: string, view: ClearView): Promise<void> {
      for (const { issuance } of view.inputs) {
        if (issuance?.contract === undefined) continue;
        const { name, ticker, precision, domain } = issuance.contract;
        try {
          await put(chain, { id: issuance.asset.asset, name, ticker, precision, domain, source: "signed" });
        } catch (error) {
          if (!(error instanceof ProviderRpcError)) throw error;
        }
      }
    },

    /** Adds `asset` by its contract (exact JSON), once checked against the chain. */
    async addByContract(module: ChainModule, client: EsploraClient, asset: string, contract: string): Promise<StoredAsset> {
      return put(module.declare().binding.chain, await checkedContract(module, client, assetId(asset), contract));
    },

    /**
     * The user's own name for `asset`, which has no contract: shown as theirs, never as checked.
     * Renames an earlier label or an app's name; never replaces a name from the asset's contract.
     */
    async label(chain: string, asset: string, label: Pick<StoredAsset, "name" | "ticker" | "precision">): Promise<StoredAsset> {
      const id = assetId(asset);
      checkLabel(label);
      const existing = (await stored(chain))[id];
      if (fromContract(existing)) {
        throw refused(`This asset is named ${existing!.ticker} from its contract. Remove that name first to give it your own.`);
      }
      return put(chain, { id, name: label.name, ticker: label.ticker, precision: label.precision, source: "label" });
    },

    /**
     * What `origin` suggests naming an asset, checked as far as it can be before the user is asked:
     * a contract against the chain, a plain name against a label's rules, either against the Chain
     * Entry's tickers. A name from the asset's contract is never replaced. `replaces` is what the
     * store has for it now, for the user to see. Stores nothing: `save` does, once they approve.
     */
    async suggestion(
      module: ChainModule,
      client: EsploraClient | undefined,
      origin: string,
      { asset, contract, label }: AssetSuggestion,
    ): Promise<{ chain: string; asset: StoredAsset; replaces?: StoredAsset }> {
      const chain = module.declare().binding.chain;
      const id = assetId(asset);
      if ((contract === undefined) === (label === undefined)) throw refused("suggestAsset needs exactly one of `contract` or `label`.");
      let suggested: StoredAsset;
      if (contract !== undefined) {
        if (client === undefined) throw refused(`This wallet can't check contracts on ${chain}: its server doesn't say how an asset was issued.`);
        suggested = { ...(await checkedContract(module, client, id, contract)), origin };
      } else {
        const { name, ticker, precision } = (label ?? {}) as Partial<StoredAsset>;
        checkLabel({ name: name!, ticker: ticker!, precision: precision! });
        suggested = { id, name: name!, ticker: ticker!, precision: precision!, source: "app", origin };
      }
      await admissible(chain, suggested);
      const existing = (await stored(chain))[id];
      if (suggested.source === "app" && fromContract(existing)) throw refused(`This wallet already names asset ${id} ${existing!.ticker}, from its contract.`);
      return { chain, asset: suggested, ...(existing === undefined ? {} : { replaces: existing }) };
    },

    /** Stores a suggestion the user approved; its rules are checked again. */
    save: (chain: string, asset: StoredAsset): Promise<StoredAsset> => put(chain, asset),

    /** Forgets `asset`'s stored name, whatever its source: it shows as an unknown asset again. */
    async remove(chain: string, asset: string): Promise<void> {
      const { [String(asset).toLowerCase()]: _, ...rest } = await stored(chain);
      await store.set(storeKey(chain), rest);
    },
  };
}

export type Assets = ReturnType<typeof createAssets>;
