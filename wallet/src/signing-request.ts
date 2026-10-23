// The Signing Request envelope (spec #18 "Signing Request"): parsing and the envelope's own
// validation steps. The rest of the order (Grant, then the Chain Module's payload rules) runs in
// the Provider handler.
import { ErrorCode, ProviderRpcError } from "./errors";

/** Envelope MAJOR versions this wallet understands. */
export const SUPPORTED_MAJOR = 1;

export interface SigningRequest {
  /** MAJOR.MINOR. */
  version: string;
  id: string;
  /** CAIP-2 in our own namespace: `ecash:<network>-s<slot>`. */
  chain: string;
  /** The Slot named by `chain`. */
  slot: number;
  method: "signTransaction";
  format: string;
  /** Base64. */
  payload: string;
  /** Seconds since the epoch. */
  expiresAt: number;
  /** Requester-supplied, shown only tagged "Reported by <origin>". */
  hints?: { summary?: string; outputLabels?: Record<string, string> };
  /**
   * Requester-supplied, `{ [kind]: … }`: passed as is to the Slot's Chain Module, which checks each
   * kind it knows against the payload and refuses the request if one doesn't check out (docs/adr/0009).
   */
  evidence?: unknown;
}

const invalid = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

/**
 * Steps 1-3 of the validation order: an unknown MAJOR is refused (4200); unknown envelope fields
 * are ignored (dropped here); an expired request is refused. `nowSeconds` is the wallet's clock.
 */
export function parseSigningRequest(params: unknown, nowSeconds: number): SigningRequest {
  const p = (params ?? {}) as Record<string, unknown>;

  // 1. MAJOR first: a future major may change everything else.
  const version = typeof p.version === "string" ? /^(\d+)\.(\d+)$/.exec(p.version) : null;
  if (version === null) throw invalid("A Signing Request needs `version`: \"MAJOR.MINOR\".");
  if (Number(version[1]) !== SUPPORTED_MAJOR) {
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported Signing Request version ${p.version}.`);
  }

  // 2. Only known fields are read; anything else is ignored.
  const { id, chain, method, format, payload, expiresAt, hints, evidence } = p;
  if (typeof id !== "string" || id === "") throw invalid("A Signing Request needs `id`.");
  const slot = typeof chain === "string" ? /^ecash:[a-z0-9-]+-s(\d{1,3})$/.exec(chain) : null;
  if (slot === null || Number(slot[1]) < 1 || Number(slot[1]) > 255) {
    throw invalid("A Signing Request needs `chain`: \"ecash:<network>-s<slot>\".");
  }
  if (method !== "signTransaction") throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported Signing Request method: ${String(method)}.`);
  if (typeof format !== "string") throw invalid("A Signing Request needs `format`.");
  if (typeof payload !== "string" || payload === "") throw invalid("A Signing Request needs `payload` (base64).");
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw invalid("A Signing Request needs `expiresAt` (seconds since the epoch).");

  // 3. Expiry.
  if (expiresAt <= nowSeconds) throw invalid("This Signing Request has expired.");

  return {
    version: p.version as string,
    id,
    chain: chain as string,
    slot: Number(slot[1]),
    method,
    format,
    payload,
    expiresAt,
    ...(parseHints(hints) ?? {}),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function parseHints(hints: unknown): Pick<SigningRequest, "hints"> | undefined {
  if (typeof hints !== "object" || hints === null) return undefined;
  const { summary, outputLabels } = hints as Record<string, unknown>;
  const labels =
    typeof outputLabels === "object" && outputLabels !== null
      ? Object.fromEntries(Object.entries(outputLabels).filter(([, v]) => typeof v === "string") as [string, string][])
      : undefined;
  return { hints: { ...(typeof summary === "string" ? { summary } : {}), ...(labels ? { outputLabels: labels } : {}) } };
}
