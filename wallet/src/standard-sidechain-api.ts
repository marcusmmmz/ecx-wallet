// The wallet's client for the Standard Sidechain API (`ecx-v0`; HTTPS + JSON, paths under `/v1`).
// The protocol is documented next to the stub server, stub-server/README.md. The server knows the
// watch by the id it returns from registration; the client registers before every call (it's
// idempotent, and a server may forget watches), so callers only ever pass watch data.
import { isAssetAmount, serverFetch, SidechainServerError, type Fetch, type HistoryEntry, type SidechainServer, type WatchData } from "./sidechain-server";

/** An asset amount that may be negative: a net change. */
function isNetAmount(a: unknown): boolean {
  const { amount } = (a ?? {}) as Record<string, unknown>;
  return typeof amount === "string" && isAssetAmount({ ...(a as object), amount: amount.replace(/^-/, "") });
}

/** A draft 2 history entry: a net amount may be negative, and a pending one says whether it's trusted. */
function isHistoryEntry(e: unknown): e is HistoryEntry {
  const { txid, amounts, confirmed, time, trusted } = (e ?? {}) as Record<string, unknown>;
  return (
    typeof txid === "string" &&
    /^[0-9a-f]{64}$/.test(txid) &&
    Array.isArray(amounts) &&
    amounts.every(isNetAmount) &&
    typeof confirmed === "boolean" &&
    (time === undefined || (confirmed && Number.isSafeInteger(time) && (time as number) >= 0)) &&
    (confirmed ? trusted === undefined : typeof trusted === "boolean")
  );
}

export function standardSidechainServer(baseUrl: string, fetchFn: Fetch): SidechainServer {
  const url = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await serverFetch(fetchFn, url, path, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new SidechainServerError(url, `The Sidechain Server at ${url} sent an answer that isn't JSON.`);
    }
    if (!response.ok) {
      const error = (answer as { error?: { code?: unknown; message?: unknown } })?.error;
      const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new SidechainServerError(url, `The Sidechain Server at ${url} refused: ${message}`, typeof error?.code === "string" ? error.code : undefined);
    }
    return answer as T;
  }

  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** Registers the watch (its descriptor and receive addresses); returns the path of its resources. */
  async function register({ chain, descriptor, receive }: WatchData): Promise<string> {
    const addresses = receive.map(({ index, address, scriptPubkey }) => ({ index, address, scriptPubkey }));
    const { watchId } = await call<{ watchId?: unknown }>("POST", "/v1/watch", { chain, descriptor, addresses });
    if (typeof watchId !== "string" || watchId === "") throw malformed("registration answer");
    return `/v1/watch/${encodeURIComponent(watchId)}`;
  }

  const amounts = (list: { asset: string; amount: string }[]) => list.map(({ asset, amount }) => ({ asset, amount }));

  return {
    url,
    async state(watch) {
      const { balances, unconfirmed = [] } = await call<{ balances?: unknown; unconfirmed?: unknown }>("GET", `${await register(watch)}/state`);
      if (!Array.isArray(balances) || !balances.every(isAssetAmount)) throw malformed("state");
      // Optional: a server that leaves it out has nothing pending.
      if (!Array.isArray(unconfirmed) || !unconfirmed.every(isAssetAmount)) throw malformed("state");
      return { balances: amounts(balances), unconfirmed: amounts(unconfirmed) };
    },
    // The same `state` call: the server reports history alongside balances.
    async history(watch) {
      const { history } = await call<{ history?: unknown }>("GET", `${await register(watch)}/state`);
      if (!Array.isArray(history) || !history.every(isHistoryEntry)) throw malformed("history");
      const entries = history.map((entry) => ({
        txid: entry.txid,
        amounts: amounts(entry.amounts),
        confirmed: entry.confirmed,
        ...(entry.time === undefined ? {} : { time: entry.time }),
        ...(entry.trusted === undefined ? {} : { trusted: entry.trusted }),
      }));
      return { entries, partial: false };
    },
    buildTransfer: async (watch, order) => call<unknown>("POST", `${await register(watch)}/transfers`, order),
    async submit(watch, requestId, payload) {
      const { accepted, txid } = await call<{ accepted?: unknown; txid?: unknown }>("POST", `${await register(watch)}/submissions`, { requestId, payload });
      return { accepted: accepted === true, ...(typeof txid === "string" ? { txid } : {}) };
    },
  };
}
