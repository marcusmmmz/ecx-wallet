/** Methods a Grant can cover. `connect` and `disconnect` need no Grant. */
export const GRANTABLE_METHODS = ["getAddresses", "signTransaction", "sendTransfer", "suggestAsset"] as const;
export type GrantableMethod = (typeof GRANTABLE_METHODS)[number];

export interface Scope {
  slots: number[];
  methods: GrantableMethod[];
}

/** A user's stored approval for one web origin. */
export interface Grant extends Scope {
  origin: string;
  /** Separate, off-by-default opt-in: without it, Blind requests are refused outright. */
  blindSigning: boolean;
}

/** Where Grants persist. The extension backs it with `storage.local`. */
export interface GrantStore {
  get(origin: string): Promise<Grant | undefined>;
  put(grant: Grant): Promise<void>;
  /** Removing a Grant that isn't there is a no-op. */
  remove(origin: string): Promise<void>;
  /** Every stored Grant, for the Grants screen. */
  list(): Promise<Grant[]>;
}

export function covers(grant: Grant | undefined, scope: Scope): boolean {
  return (
    grant !== undefined &&
    scope.slots.every((s) => grant.slots.includes(s)) &&
    scope.methods.every((m) => grant.methods.includes(m))
  );
}

/**
 * The Grant after the user approves `scope`: the union with what the origin already had. Blind
 * Signing turns on only if the user ticked it in the approval window (`blindSigning`).
 */
export function widen(existing: Grant | undefined, origin: string, scope: Scope, blindSigning: boolean): Grant {
  return {
    origin,
    slots: [...new Set([...(existing?.slots ?? []), ...scope.slots])],
    methods: [...new Set([...(existing?.methods ?? []), ...scope.methods])],
    blindSigning: (existing?.blindSigning ?? false) || blindSigning,
  };
}

/** What an app is told about its own Grant: by `connect` and `getGrant`, and in `grantChanged`. */
export interface GrantScope extends Scope {
  blindSigning?: true;
}

/** The Grant as its app sees it: Blind Signing named only when opted in. */
export function scopeOf(grant: Grant): GrantScope {
  return { slots: grant.slots, methods: grant.methods, ...(grant.blindSigning ? { blindSigning: true } : {}) };
}
