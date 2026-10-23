// What every Signing Request goes through once its requester is allowed to send it, whichever path
// it came by (a Sidechain App through the Provider, or the wallet's own Send through a Sidechain
// Server): its Slot's Chain Module, one approval window, then signing.
import { ErrorCode, ProviderRpcError } from "./errors";
import { ChainModuleRefusal, type ChainModule, type ClearView, type Decoded, type Starter } from "./chain-module";
import type { SigningRequest } from "./signing-request";

/** What the approval window shows for a Signing Request. */
export interface SignPrompt {
  /** Who is asking: the browser-reported web origin, or the Sidechain Server URL. */
  origin: string;
  chain: string;
  requestId: string;
  /** The Chain Module's view: a Clear View or Blind. */
  decoded: Decoded;
  /** Requester-supplied; shown only tagged "Reported by <origin>". */
  hints?: SigningRequest["hints"];
}

/** One approval window for one Signing Request; it opens on the first thing it has to show. */
export interface SigningApproval {
  /** Asks the user to unlock; true once the wallet is unlocked, false if they close the window. */
  unlock(): Promise<boolean>;
  /** Shows the request; true on approve, false on reject or close. */
  confirm(prompt: SignPrompt): Promise<boolean>;
  /** Closes the window, if open. */
  close(): void;
}

export interface SigningDeps {
  /** Slots that have a bundled Chain Module. */
  supportedSlots: readonly number[];
  /** The Slot's Chain Module (only called for a supported Slot). */
  chainModule(slot: number): Promise<ChainModule> | undefined;
  /** A window for the approval of one Signing Request from `origin` for `chain`. */
  openSigningApproval(context: { origin: string; chain: string }): SigningApproval;
  isUnlocked(): Promise<boolean>;
  /** The Slot's Starter; throws while locked. */
  starter(slot: number): Promise<Starter>;
  /** Milliseconds since the epoch. */
  now(): number;
}

export const rejected = () => new ProviderRpcError(ErrorCode.UserRejected, "The user rejected the request.");

/** The Chain Module that serves `request`: its own Slot's, and only if bound to its chain and format. */
export async function chainModuleFor(deps: SigningDeps, request: SigningRequest): Promise<ChainModule> {
  const pending = deps.supportedSlots.includes(request.slot) ? deps.chainModule(request.slot) : undefined;
  if (pending === undefined) {
    throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet has no Chain Module for Slot ${request.slot}.`);
  }
  const module = await pending;
  const { binding } = module.declare();
  if (binding.chain !== request.chain) {
    throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet's Slot ${request.slot} serves ${binding.chain}, not ${request.chain}.`);
  }
  if (binding.format !== request.format) {
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported format ${request.format} for ${request.chain}.`);
  }
  return module;
}

/**
 * Validation steps 5-7 as far as they need no Starter (the Chain Module's `check`, before any unlock
 * prompt), then unlock if needed, the rest of step 7 and Blind vs `blindRefusal` (both need the
 * Starter to decode), the user's approval and
 * the signature. `blindRefusal` is why a Blind request must be refused, or undefined if the
 * requester may Blind-sign. The request only ever reaches its own Slot's Chain Module, with that
 * Slot's Starter. Returns the signed payload. `approval` is a window the caller already opened (to
 * unlock before the request was built); it is closed either way. `expect` checks a Clear View
 * before the user sees it, and throws to refuse it.
 */
export async function reviewAndSign(
  deps: SigningDeps,
  {
    requester,
    request,
    module,
    blindRefusal,
    approval: opened,
    expect,
  }: {
    requester: string;
    request: SigningRequest;
    module: ChainModule;
    blindRefusal?: string;
    approval?: SigningApproval;
    expect?: (view: ClearView) => void;
  },
): Promise<string> {
  const nowSeconds = () => Math.floor(deps.now() / 1000);
  const approval = opened ?? deps.openSigningApproval({ origin: requester, chain: request.chain });
  try {
    // Everything that needs no Starter comes before the user is asked to unlock.
    await refusing(async () => module.check(request.payload));
    if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();

    const decoded = await refusing(async () => module.decode(request.payload, await deps.starter(request.slot)));
    if (decoded.kind === "blind" && blindRefusal !== undefined) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, blindRefusal);
    }
    if (decoded.kind === "clear") expect?.(decoded.view);
    const prompt: SignPrompt = {
      origin: requester,
      chain: request.chain,
      requestId: request.id,
      decoded,
      ...(request.hints ? { hints: request.hints } : {}),
    };
    if (!(await approval.confirm(prompt))) throw rejected();
    if (request.expiresAt <= nowSeconds()) {
      throw new ProviderRpcError(ErrorCode.InvalidParams, "This Signing Request expired while waiting for approval.");
    }
    return await refusing(async () => module.sign(request.payload, await deps.starter(request.slot)));
  } finally {
    approval.close();
  }
}

/** A Chain Module's refusal, as the requester sees it. */
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ChainModuleRefusal) throw new ProviderRpcError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}
