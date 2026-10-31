// Vault orchestration: encryption at rest and unlock state around vault.wasm.
//
// - At rest: the Master Mnemonic (and its optional passphrase) is stored only encrypted:
//   password → Argon2id (vault.wasm) → 32-byte vault key → AES-256-GCM (WebCrypto).
// - Unlocked: the vault key, never the mnemonic, sits in session storage (memory-only, cleared
//   when the browser closes) with a deadline; any use past the deadline locks first.
// - Only the background calls this. Pages get status and send passwords; they never receive the
//   key, the stored mnemonic or a Starter.
import type { L1AccountKey, Starter } from "./chain-module";
import type { KdfParams, VaultModule } from "./vault-module";

/** Minimal async key-value storage (the extension backs it with `chrome.storage.*`). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Stored keys, for enumerating Grants, pending transactions and session caches. */
  keys(): Promise<string[]>;
}

export interface VaultDeps {
  /** vault.wasm, loaded on first use. */
  module(): Promise<VaultModule>;
  /** Survives browser restarts: the vault (encrypted), settings, and what's kept of the chains (Deposits, history). */
  persistent: KeyValueStore;
  /** Memory-only, cleared when the browser closes: holds the vault key while unlocked. */
  session: KeyValueStore;
  random(length: number): Uint8Array;
  now(): number;
  /** Called with the new auto-lock deadline (ms since epoch) whenever it moves, or null on lock. */
  onDeadline?(deadline: number | null): void | Promise<void>;
}

export interface VaultStatus {
  /** A wallet was created or imported in this profile. */
  exists: boolean;
  unlocked: boolean;
  /** While unlocked: when it locks itself without further use, in ms since the epoch. */
  locksAt?: number;
  /** How long without use before it locks itself. */
  autoLockMinutes: number;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export const INCORRECT_PASSWORD = "Incorrect password.";
/** The auto-lock delay: the default is also the longest it can be set to. */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;
export const MIN_AUTO_LOCK_MINUTES = 1;
export const MIN_PASSWORD_LENGTH = 8;

const VAULT_KEY = "vault";
const SETTINGS_AUTO_LOCK = "settings:autoLockMinutes";
const SESSION_KEY = "vault:key";
const SESSION_DEADLINE = "vault:unlockedUntil";
const KDF: KdfParams = { mKib: 65536, t: 3, p: 1 };
const AAD = new TextEncoder().encode("ecx-wallet vault v1");

/** What `storage.local` holds: nothing here is readable without the password. */
interface EncryptedVault {
  version: 1;
  kdf: { alg: "argon2id"; salt: string } & KdfParams;
  cipher: { alg: "AES-GCM"; iv: string; data: string };
}

/** The plaintext inside the ciphertext. */
interface VaultSecrets {
  masterMnemonic: string;
  passphrase: string;
}

export function createVault(deps: VaultDeps) {
  const { persistent, session } = deps;

  // Unlock-state changes run one at a time: otherwise a use that checked "unlocked" before a lock
  // could extend the deadline (re-storing the key) after it.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = tail.then(step, step);
    tail = run.catch(() => {});
    return run;
  }

  // Reads the wallet runs by itself (a shown page reading its chains again) under way: while any
  // is, a key derivation doesn't count as activity, so an open, unused wallet still locks on time.
  let unattended = 0;

  async function autoLockMs(): Promise<number> {
    return clampAutoLock((await persistent.get<number>(SETTINGS_AUTO_LOCK)) ?? DEFAULT_AUTO_LOCK_MINUTES) * 60_000;
  }

  async function lock(): Promise<void> {
    await session.remove(SESSION_KEY);
    await session.remove(SESSION_DEADLINE);
    await deps.onDeadline?.(null);
  }

  /** Starts or extends the unlocked period with `key` (raw AES key bytes). */
  async function keepUnlocked(key: Uint8Array): Promise<void> {
    const deadline = deps.now() + (await autoLockMs());
    await session.set(SESSION_KEY, toBase64(key));
    await session.set(SESSION_DEADLINE, deadline);
    await deps.onDeadline?.(deadline);
  }

  /** The vault's secrets, if it is unlocked now; locks it if the deadline has passed. */
  async function unlocked(): Promise<{ key: Uint8Array; secrets: VaultSecrets } | undefined> {
    const [vault, key, deadline] = await Promise.all([
      persistent.get<EncryptedVault>(VAULT_KEY),
      session.get<string>(SESSION_KEY),
      session.get<number>(SESSION_DEADLINE),
    ]);
    if (vault === undefined || key === undefined || deadline === undefined) return undefined;
    if (deps.now() >= deadline) {
      await lock();
      return undefined;
    }
    const raw = fromBase64(key);
    const secrets = await decrypt(vault, raw);
    if (secrets === undefined) {
      await lock();
      return undefined;
    }
    return { key: raw, secrets };
  }

  /** The secrets a key derivation needs; counts as activity, unless unattended. Throws if the wallet is locked. */
  async function secretsInUse(): Promise<VaultSecrets> {
    const open = await exclusive(async () => {
      const open = await unlocked();
      if (open !== undefined && unattended === 0) await keepUnlocked(open.key);
      return open;
    });
    if (open === undefined) throw new VaultError("The wallet is locked.");
    return open.secrets;
  }

  async function store(secrets: VaultSecrets, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new VaultError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if ((await persistent.get(VAULT_KEY)) !== undefined) {
      throw new VaultError("This browser profile already has a wallet.");
    }
    const module = await deps.module();
    const salt = deps.random(16);
    const key = module.stretchPassword(new TextEncoder().encode(password), salt, KDF);
    const iv = deps.random(12);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD },
      await aesKey(key),
      new TextEncoder().encode(JSON.stringify(secrets)),
    );
    const vault: EncryptedVault = {
      version: 1,
      kdf: { alg: "argon2id", salt: toBase64(salt), ...KDF },
      cipher: { alg: "AES-GCM", iv: toBase64(iv), data: toBase64(new Uint8Array(data)) },
    };
    await persistent.set(VAULT_KEY, vault);
    await keepUnlocked(key);
  }

  return {
    status: (): Promise<VaultStatus> =>
      exclusive(async () => {
        const exists = (await persistent.get(VAULT_KEY)) !== undefined;
        const open = exists && (await unlocked()) !== undefined;
        const autoLockMinutes = (await autoLockMs()) / 60_000;
        if (!open) return { exists, unlocked: false, autoLockMinutes };
        return { exists, unlocked: true, locksAt: await session.get<number>(SESSION_DEADLINE), autoLockMinutes };
      }),

    /** Someone is using a wallet page: counts as activity (moves the deadline), if unlocked. */
    touch: () =>
      exclusive(async () => {
        const open = await unlocked();
        if (open !== undefined) await keepUnlocked(open.key);
      }),

    /**
     * Runs `run`, a read the wallet makes by itself, without its key derivations counting as
     * activity. Someone using the wallet meanwhile still does: their pages report it (`touch`).
     */
    async unattended<T>(run: () => Promise<T>): Promise<T> {
      unattended += 1;
      try {
        return await run();
      } finally {
        unattended -= 1;
      }
    },

    /** A fresh Master Mnemonic for the create flow. Not stored until `create`. */
    async generate(): Promise<string> {
      return (await deps.module()).masterMnemonicFromEntropy(deps.random(16));
    },

    /** Stores a new or imported Master Mnemonic under `password` and leaves the wallet unlocked. */
    async create({ masterMnemonic, passphrase = "", password }: { masterMnemonic: string; passphrase?: string; password: string }) {
      let canonical: string;
      try {
        canonical = (await deps.module()).canonicalMnemonic(masterMnemonic);
      } catch {
        throw new VaultError("That is not a valid Master Mnemonic (12 or 24 BIP39 words).");
      }
      await store({ masterMnemonic: canonical, passphrase }, password);
    },

    /** Unlocks with `password`. Any failure is reported only as INCORRECT_PASSWORD. */
    async unlock(password: string): Promise<void> {
      const vault = await persistent.get<EncryptedVault>(VAULT_KEY);
      if (vault === undefined) throw new VaultError("There is no wallet to unlock.");
      const { salt, mKib, t, p } = vault.kdf;
      // The same work runs for every password; the only signal is whether AES-GCM authenticates.
      const key = (await deps.module()).stretchPassword(new TextEncoder().encode(password), fromBase64(salt), { mKib, t, p });
      if ((await decrypt(vault, key)) === undefined) throw new VaultError(INCORRECT_PASSWORD);
      await exclusive(() => keepUnlocked(key));
    },

    lock: () => exclusive(lock),

    /** Locks now if the auto-lock deadline has passed (for a timer firing). */
    checkAutoLock: () => exclusive(async () => void (await unlocked())),

    /**
     * Sets the auto-lock delay, clamped to MIN_AUTO_LOCK_MINUTES-DEFAULT_AUTO_LOCK_MINUTES: it can be
     * shortened (the e2e suite uses that), never lengthened past the default or turned off.
     */
    async setAutoLockMinutes(minutes: number): Promise<void> {
      if (Number.isNaN(minutes)) throw new VaultError("Auto-lock needs a number of minutes.");
      await persistent.set(SETTINGS_AUTO_LOCK, clampAutoLock(minutes));
    },

    /**
     * The Starter for `slot`, derived on demand and never stored. Counts as activity (extends the
     * auto-lock deadline). Throws if the wallet is locked.
     */
    async starter(slot: number): Promise<Starter> {
      const { masterMnemonic, passphrase } = await secretsInUse();
      return (await deps.module()).starter(masterMnemonic, passphrase, slot);
    },

    /** The L1 Account Key, derived on demand and never stored; as `starter`, it counts as activity. */
    async l1AccountKey(): Promise<L1AccountKey> {
      const { masterMnemonic, passphrase } = await secretsInUse();
      return (await deps.module()).l1AccountKey(masterMnemonic, passphrase);
    },
  };
}

export type Vault = ReturnType<typeof createVault>;

/** An auto-lock delay within MIN_AUTO_LOCK_MINUTES-DEFAULT_AUTO_LOCK_MINUTES. */
function clampAutoLock(minutes: number): number {
  return Math.min(DEFAULT_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, minutes));
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function decrypt(vault: EncryptedVault, key: Uint8Array): Promise<VaultSecrets | undefined> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(vault.cipher.iv) as BufferSource, additionalData: AAD },
      await aesKey(key),
      fromBase64(vault.cipher.data) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as VaultSecrets;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
