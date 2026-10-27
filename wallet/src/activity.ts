// The Activity tab's feed: every chain's transactions in one list, the unconfirmed first, then
// one section per day, newest first.
import type { HistoryEntry } from "./sidechain-server";

/** What a transaction did for the wallet. */
export type ActivityKind = "received" | "sent" | "toSelf" | "deposit" | "depositCredit" | "issuance" | "reissuance" | "confidential" | "trade";

export function activityKind(entry: HistoryEntry): ActivityKind {
  if (entry.trade !== undefined) return "trade";
  if (entry.depositTo !== undefined) return "deposit";
  if (entry.depositFrom !== undefined) return "depositCredit";
  if (entry.issuance !== undefined) return entry.issuance === "new" ? "issuance" : "reissuance";
  if (entry.toSelf) return "toSelf";
  if (entry.amounts.length === 0 && entry.hidden) return "confidential";
  return entry.amounts.some((a) => a.amount.startsWith("-")) ? "sent" : "received";
}

/** The local calendar day of a block time (seconds), as `YYYY-MM-DD`. */
export function localDay(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ActivityItem<C> {
  chain: C;
  entry: HistoryEntry;
}

/**
 * `lists` (each chain's entries, as its server lists them) merged: an "unconfirmed" section first,
 * in chain order, then one per day (`dayOf`), newest first. Empty sections are left out.
 */
export function activityDays<C>(
  lists: { chain: C; entries: HistoryEntry[] }[],
  dayOf: (seconds: number) => string = localDay,
): { day: string; items: ActivityItem<C>[] }[] {
  const items = lists.flatMap(({ chain, entries }) => entries.map((entry) => ({ chain, entry })));
  const unconfirmed = items.filter((i) => !i.entry.confirmed);
  // Stable: same-time entries keep chain order. A confirmed entry without a time sorts last.
  const confirmed = items.filter((i) => i.entry.confirmed).sort((a, b) => (b.entry.time ?? 0) - (a.entry.time ?? 0));
  const days: { day: string; items: ActivityItem<C>[] }[] = unconfirmed.length > 0 ? [{ day: "unconfirmed", items: unconfirmed }] : [];
  for (const item of confirmed) {
    const day = item.entry.time === undefined ? "undated" : dayOf(item.entry.time);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1)!.items.push(item);
  }
  return days;
}
