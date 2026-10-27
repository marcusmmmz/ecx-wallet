import type { AssetSource } from "@ecx/wallet";

/**
 * An asset id shortened for display: its first and last 8 hex digits. Both ends, so two assets
 * can't pass for each other by sharing a prefix; show the full id alongside wherever it matters.
 */
export const shortAsset = (asset: string) => (asset.length > 20 ? `${asset.slice(0, 8)}…${asset.slice(-8)}` : asset);

/**
 * Where a name the asset store gave comes from, as screens mark it (docs/adr/0010); undefined for
 * one its Chain Entry names, which needs no mark. A name an app suggested says which app.
 */
export function assetSource(entry: { source?: AssetSource; origin?: string } | undefined): string | undefined {
  switch (entry?.source) {
    case undefined:
      return undefined;
    case "label":
      return "your label";
    case "app":
      return `named by ${entry.origin ?? "an app"}`;
    case "registration":
      return "from its registration";
    default:
      return "from its contract";
  }
}

/**
 * How far a screen vouches for an asset's name (docs/adr/0015): `verified` if its Chain Entry
 * names it (shipped with the wallet); `none` for ECX, which carries eCash's own mark, the user's own
 * label, or an asset they issued;
 * `unverified` for every other name, and for an unknown asset. Anyone can issue or register an
 * asset under any free ticker ("USDT"), so a name from its contract, its registration or an app
 * proves only that the asset calls itself that.
 */
export type AssetTrust = "verified" | "unverified" | "none";

export function assetTrust(entry: { source?: AssetSource; ecx?: boolean } | undefined): AssetTrust {
  if (entry === undefined) return "unverified";
  if (entry.ecx) return "none";
  switch (entry.source) {
    case undefined:
      return "verified";
    case "label":
    case "signed":
      return "none";
    default:
      return "unverified";
  }
}
