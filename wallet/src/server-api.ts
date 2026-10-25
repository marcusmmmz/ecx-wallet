// Which client speaks to a chain's Sidechain Server: the Server API its Chain Entry names.
import type { SessionCache } from "./cache";
import type { ChainEntry, NetworkEntry, OutputTokens, ServerApi } from "./chain-module";
import { esploraServer, FLUSH_STALL_SECONDS, type EsploraServerConfig } from "./esplora";
import { SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";
import { standardSidechainServer } from "./standard-sidechain-api";

/** True if the wallet reads a server of this API as Esplora: `esplora`, and Flush's (`flush`), which adds to it. */
export const speaksEsplora = (api: ServerApi): boolean => api === "esplora" || api === "flush";

/**
 * How to reach `network`'s default server over Esplora: Flush's (`flush`) also reports finality
 * and can stall (docs/adr/0012). `tokens` reads what a transaction's outputs carry, where the
 * chain's module declares it (docs/adr/0013).
 */
export function esploraConfig(
  entry: ChainEntry,
  network: NetworkEntry,
  cache?: SessionCache,
  tokens?: (tx: string) => Promise<OutputTokens | undefined>,
): EsploraServerConfig {
  const { api, url } = network.sidechainServer;
  const flush = api === "flush" ? { finality: true, stallAfter: FLUSH_STALL_SECONDS } : {};
  return { url, identityBlock: network.identityBlock, chainName: entry.name, cache, ...flush, ...(tokens === undefined ? {} : { tokens }) };
}

/** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
export function sidechainServer(
  entry: ChainEntry,
  network: NetworkEntry,
  fetchFn: Fetch = (...args) => fetch(...args),
  cache?: SessionCache,
  tokens?: (tx: string) => Promise<OutputTokens | undefined>,
): SidechainServer {
  const { api, url } = network.sidechainServer;
  switch (api) {
    case "ecx-v0":
      return standardSidechainServer(url, fetchFn);
    case "esplora":
    case "flush":
      return esploraServer(esploraConfig(entry, network, cache, tokens), fetchFn);
    default:
      throw new SidechainServerError(url, `${entry.name}'s Chain Entry names a Server API this wallet doesn't speak: ${String(api)}.`);
  }
}
