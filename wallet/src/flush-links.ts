// flush.markets' `flush:` links (docs/adr/0016): the network a link names, and the record that a
// link already ran, so a trade link left in the browser's history can't run twice.

/** The `network` a link names for each of the Chain Entry's networks (Flush's own `CheckNetwork`). */
export const LINK_NETWORKS: Readonly<Record<string, string>> = { mainnet: "ecash", betanet: "ecashbeta", testnet: "ecashtest" };

/** Links that ran this session, by their SHA-256 (`storage.session`: forgotten when the browser closes). */
export interface UsedLinks {
  has(digest: string): Promise<boolean>;
  add(digest: string): Promise<void>;
}

/** A link's SHA-256, lowercase hex, as Flush's own app keeps it. */
export async function linkDigest(link: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(link));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
