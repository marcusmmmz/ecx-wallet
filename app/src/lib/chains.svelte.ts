// What the unlocked home and chain screens show about each chain: its Chain Entry's word on it, its
// receive address, what its server reports, and (for a Slot) its Deposits. Each read is the
// background's; this only keeps the answers, per chain, and asks again on Retry.
import {
  cachedHistory,
  cachedState,
  l1Account,
  l1Cached,
  l1Reported,
  listAccounts,
  listChains,
  listDeposits,
  nameFromRegistrations,
  refusedDeposit,
  refusedSend,
  reportedHistory,
  reportedState,
  showReport,
  type ChainHistory,
  type AssetEntry,
  type ChainId,
  type ChainInfo,
  type ChainReport,
  type DepositStatus,
  type RefusedDeposit,
  type RefusedSend,
  type ShownReport,
} from "$lib/background";
import { assetsOf } from "$lib/unit.svelte";

export interface ChainView {
  info: ChainInfo;
  /** Its first receive address, once derived. */
  address?: string;
  /** What its server reports (the last report while refreshing), or why it couldn't be read. */
  shown: ShownReport;
  /** A Slot's pending Deposits, or why their status couldn't be read; undefined until read. */
  deposits?: DepositStatus[] | { error: string };
  /** A Slot's last Deposit that failed after approval, or null; undefined until read. */
  refused?: RefusedDeposit | null;
  /** A Slot's last Send that failed after approval, or null; undefined until read. */
  refusedSend?: RefusedSend | null;
  /** Its transactions (this session's last while refreshing), once its Activity was opened. */
  history?: ShownReport<ChainHistory>;
}

export class Chains {
  /** Every chain this release supports, on or off. */
  all = $state<ChainView[] | undefined>(undefined);
  error = $state("");

  /** The chains the user has on: the only ones shown, counted and read. */
  get list(): ChainView[] | undefined {
    return this.all?.filter((c) => c.info.on);
  }

  /** Every Slot, on or off: a Deposit in progress to a chain that's off still shows. */
  get slots(): ChainView[] {
    return (this.all ?? []).filter((c) => c.info.id !== "l1");
  }

  /**
   * Reads every chain that's on, and every Slot's Deposits; `only` limits the reads to one chain (a
   * chain's own screen), though every chain is named.
   */
  async load(only?: ChainId) {
    try {
      this.all = (await listChains()).map((info) => ({ info, shown: { refreshing: true } }));
    } catch (e) {
      this.error = (e as Error).message;
      return;
    }
    this.readAddresses(only);
    for (const { info } of this.all) {
      if (only !== undefined && info.id !== only) continue;
      if (info.on) this.readReport(info.id);
      if (info.id !== "l1") this.readDeposits(info.id);
    }
  }

  get(id: ChainId): ChainView | undefined {
    return this.all?.find((c) => c.info.id === id);
  }

  /** Asks the chain's server again. */
  retry(id: ChainId) {
    this.readReport(id);
  }

  /** Reads the chains' transactions: on opening an Activity tab, and on Retry. */
  readHistory(ids: ChainId[]) {
    for (const id of ids) {
      const slot = id === "l1" ? undefined : id;
      showReport(() => cachedHistory(slot), () => reportedHistory(slot), (history) => this.update(id, { history }));
    }
  }

  /** Reads a Slot's Deposits and refused Send again (after Stop tracking or closing a refused one). */
  readDeposits(slot: number) {
    refusedSend(slot).then(
      (r) => this.update(slot, { refusedSend: r }),
      () => this.update(slot, { refusedSend: null }),
    );
    refusedDeposit(slot).then(
      (r) => this.update(slot, { refused: r }),
      () => this.update(slot, { refused: null }),
    );
    listDeposits(slot).then(
      (d) => this.update(slot, { deposits: d }),
      (e) => this.update(slot, { deposits: { error: (e as Error).message } }),
    );
  }

  private update(id: ChainId, change: Partial<ChainView>) {
    const view = this.get(id);
    if (view) Object.assign(view, change);
  }

  private readReport(id: ChainId) {
    const show = (shown: ShownReport) => {
      this.update(id, { shown });
      if (id !== "l1" && shown.report !== undefined && !shown.refreshing) this.nameUnknown(id, shown.report);
    };
    if (id === "l1") showReport(l1Cached, l1Reported, show);
    else showReport(() => cachedState(id), () => reportedState(id), show);
  }

  /** On a chain whose assets are named from their registrations (Flush), names those the report shows unnamed. */
  private nameUnknown(slot: number, report: ChainReport) {
    const info = this.get(slot)?.info;
    if (info?.checksNames !== "registration") return;
    const unknown = assetsOf(report).map((a) => a.asset).filter((asset) => !info.assets.some((a) => a.id === asset));
    if (unknown.length === 0) return;
    nameFromRegistrations(slot, unknown).then(
      (assets) => this.update(slot, { info: { ...info, assets } }),
      () => {},
    );
  }

  private readAddresses(only?: ChainId) {
    const fail = (e: unknown) => (this.error = (e as Error).message);
    if (only === undefined || only === "l1") l1Account().then(({ addresses }) => this.update("l1", { address: addresses[0]?.address }), fail);
    if (only !== "l1") {
      listAccounts().then((accounts) => {
        for (const { slot, addresses } of accounts) if (this.get(slot)?.info.on) this.update(slot, { address: addresses[0]?.address });
      }, fail);
    }
  }
}

/** Where a Deposit stands, in words. */
export function depositState(d: DepositStatus): string {
  switch (d.state) {
    case "confirming":
      return `${d.confirmations} / ${d.depositConfirmations} confirmations on the main chain`;
    case "awaitingCredit":
      return d.paidBy === "chain" ? `Waiting for ${d.chainName} to pay it out in one of its blocks` : `Waiting for the ${d.chainName} operator to credit it (not automatic)`;
    case "credited":
      return `Credited, as reported by ${d.creditServer}`;
    case "notFound":
      return `${d.server} doesn't know this transaction: it may have lost the race for the Treasury, or been dropped`;
    case "unavailable":
      return `Status unavailable: ${d.error}`;
  }
}

/** Sats that left the main chain in a Deposit and aren't credited yet: in neither chain's balance. */
export function onTheWay(deposits: DepositStatus[]): string {
  return deposits
    .filter((d) => d.state === "confirming" || d.state === "awaitingCredit")
    .reduce((sum, d) => sum + BigInt(d.value), 0n)
    .toString();
}

/** A chain's mark: eCash's for the main chain, Flush's own (baked in, never fetched), else its initials ("Elements+" is "E+"). */
export function chainMark(info: ChainInfo): { kind: "ecash" | "flush" | "chain"; label?: string } {
  if (info.id === "l1") return { kind: "ecash" };
  // By its Chain Entry's name: Flush is a different Slot on each network (99 on betanet, 46 on mainnet).
  if (info.name === "Flush") return { kind: "flush" };
  const words = info.name.replace(/\+$/, "").split(/\s+/).filter(Boolean);
  return { kind: "chain", label: words.map((w) => w[0].toUpperCase()).slice(0, 2).join("") + (info.name.endsWith("+") ? "+" : "") };
}

/** An asset's mark: eCash's for every ECX, a named asset's checked logo or else its first letter, or unknown. */
export function assetMark(entry: (AssetEntry & { logo?: string }) | undefined): { kind: "ecash" | "asset" | "unknown"; label?: string; image?: string } {
  if (entry === undefined) return { kind: "unknown" };
  return entry.ecx ? { kind: "ecash" } : { kind: "asset", label: entry.ticker[0], ...(entry.logo === undefined ? {} : { image: entry.logo }) };
}
