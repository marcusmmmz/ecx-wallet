# How it works

One section per feature: what the user sees, then how the wallet does it, with the names to search the code for. Terms are defined in [GLOSSARY.md](../GLOSSARY.md); the reasons behind each design are in [docs/adr/](adr/).

- [The request path](#the-request-path)
- [Vault](#vault)
- [Accounts and keys](#accounts-and-keys)
- [Sidechain Servers](#sidechain-servers)
- [Home: balances and chains](#home-balances-and-chains)
- [History](#history)
- [Send](#send)
- [Deposit](#deposit)
- [The Provider](#the-provider)
- [Session cache](#session-cache)

## The request path

```text
website → client discovery → injected Provider (inpage.ts, main world)
        → content script (relay) → background → wallet's Provider handler
```

- The background takes the requester's origin from the browser's `sender`, never from the request.
- The approval window is the app page at `#/approve/<id>`. It talks to the background only through `runtime.sendMessage`.
- Wallet pages (home, Send, Settings…) talk to the background the same way, one message kind per action (`vault.*`, `send.start`, `history.reported`…). The extension's router is in `extension/src/background.ts`.

## Vault

**What the user sees:** onboarding creates or imports a wallet (`#/create`, `#/import`). The wallet then locks after 15 minutes without use, and the home header counts down ("Locks in 15 min"). Settings (`#/settings`) has Grants, the ECX/sats unit, the auto-lock delay (shown only) and Lock now.

**How:**

- **At rest:** the Master Mnemonic is stored only encrypted, in `storage.local`. The password goes through Argon2id in `vault.wasm`, and the result is the AES-GCM key used via WebCrypto. Only the background decrypts.
- **While unlocked:** the vault key sits in `storage.session` with a deadline. It survives service-worker restarts and is gone after a browser restart. The deadline is also checked on every use.
- **Auto-lock:** 15 minutes. `vault.setAutoLock` can only shorten it, clamped to 1–15 minutes.
- **What counts as use:**
  - getting a key: `await vault.starter(slot)` gives a Slot's Starter, and `await vault.l1AccountKey()` the L1 Account Key (`[fp/84h/0h/0h]xprv…`). Both throw while locked.
  - a pointer or key event on any wallet page. Pages report it on the `vault.activity` port at most once a minute (`app/src/lib/activity.ts`). The port has no reply, so a page may close mid-report. A page left open but untouched doesn't keep the wallet unlocked.
- **The countdown:** `vault.status` gives the deadline (`locksAt`) and the delay. The background announces each new deadline to open pages (`vault.deadline`).

## Accounts and keys

Every chain has a Chain Entry, and its keys follow its place in the chain tree (ADR 0003):

- **eCash**, the root (`core/l1/chain-entry.json`, no Slot or parent), gets the L1 Account Key. `l1.wasm` derives BIP84 P2WPKH addresses (`bc1q…`).
- **A Slot** under eCash gets its Starter, and only that Slot's Chain Module ever sees it.
- **Deeper chains** are refused. `createKeyRouting` in `wallet/src/accounts.ts` checks the Chain Entry before handing any key out.

`accounts.receiveAddresses(slot)` and `accounts.l1ReceiveAddresses()` do the deriving. Each module runs in its own WASM instance, created on first use.

**Receive:** home's Receive sheet shows each chain's address while unlocked (`l1.account`, `accounts.list`; the main chain comes first). Each address has Copy and a QR code (`qrMatrix`, using the bundled `qrcode-generator`).

## Sidechain Servers

Each chain is read from the Sidechain Server its Chain Entry names for the module's network, in the Server API named next to the URL: `sidechainServer: { api, url }` (ADR 0002). Today both are Esplora:

| Chain | Server (betanet) | Chain Entry |
|---|---|---|
| eCash | `https://esplora.beta.ecash.ninja` | `core/l1/chain-entry.json` |
| Slot 24 | `https://explorer.bitnames.info/api` | `core/elements/chain-entry.json` |

The extension build turns those URLs into `host_permissions` and the CSP's `connect-src`. `wallet/src/server-api.ts` picks the client for the Server API.

### Esplora (`wallet/src/esplora.ts`)

- **Identity check:** the wallet first checks `/block-height/H` against the Chain Entry's `identityBlock`. For Elements that's height 0, the genesis. eCash betanet's genesis is Bitcoin's, so it uses its fork block, 967,680 (ADR 0003). A mismatch is a hard error, and so is a server that hasn't reached H.
- **Balance:** the sum of the explicit outputs (`/address/:a/utxo`) of the first 20 receive and 20 change addresses, per asset, with confirmed and unconfirmed kept apart. eCash's outputs have no asset: they're its coin (`NATIVE_COIN`), shown in sats.
- electrs already leaves out outputs its mempool spends. So a Deposit's coin leaves the confirmed balance at once, and its change shows as unconfirmed.
- Lookups run 20 at once (`QUERIES_AT_ONCE`).
- Over Esplora the wallet builds its own transactions: Send (below) on a Slot, Deposit (below) on eCash.

### The Standard Sidechain API, `ecx-v0` (`wallet/src/standard-sidechain-api.ts`)

The API this project defines, for a sidechain with no indexer. Its protocol draft is in [stub-server/README.md](../stub-server/README.md).

- The wallet registers the descriptor and the first 20 receive addresses before every call.
- The server reports balances, with an optional `unconfirmed` list, and history in its `state` (draft 2).
- For a Send, the server builds the transfer and the wallet signs it (see [Send](#send)).
- No bundled chain speaks it yet. `e2e/tests/sidechain-servers.test.mjs` tests it in node.

## Home: balances and chains

- **One total** at the top adds up each chain's ECX: the asset its Chain Entry marks `ecx` (`totalAcrossChains`, ADR 0005). Deposits on the way show apart, never in the total.
- **One section per chain** below (`l1.reported`, `accounts.reported`), each with the confirmed balance per asset and "+N unconfirmed" beside it when there is any. Unconfirmed coins are only shown: a Deposit spends confirmed coins only.
- **Names** come from the Chain Entry: the chain ("Main chain", "Elements+") and its assets (`chains.list`). Any other asset is "Unknown asset".
- **A chain's own screen** (`#/chain/<l1|slot>`) says "Reported by <server URL>".
- **Units:** every ECX amount follows one unit, ECX or sats (`formatAmount`; `settings.unit`, kept in `storage.local`). Tapping the total switches it.

**Chains on and off:** sidechains start off (`settings.chainOn`, per chain id in `storage.local`). The Chains screen (`#/chains`, `chains.setOn`) turns them on. A chain that's off is hidden, left out of the total, Send and Receive, and the background refuses to read it ("<name> is turned off."). Its Deposits in progress still show. The main chain is always on.

## History

**What the user sees** (#33): the Activity tabs. Home's merges every chain that's on, with a chip per chain to filter. Each chain's screen has its own.

- **Order:** Deposits in progress first, then "Not yet confirmed", then one section per day (`activityDays`).
- **Each row** says what the transaction did (`activityKind`: Received, Sent, "Fee, to yourself", "Deposit to <chain>", "Deposit from the main chain"), and the wallet's net change per asset, fee included. Then its time, or a badge:
  - **Pending:** trusted. It spends only the wallet's own coins, each confirmed or from a trusted transaction.
  - **Unconfirmed:** anything else, with a warning (for a Deposit's credit: the operator credited it, not in a block yet).
- **Tapping a row** shows its status, when it was mined, the chain and its id, the txid with Copy, a Deposit's credit's main-chain txid, and who reported it.

**How:**

- History is read only when a tab is first opened: `history.reported` per chain, in parallel. This session's last one (`history.cached`) shows while it refreshes. A chain that fails says so with Retry; the others still show.
- **Over Esplora** (`SidechainServer.history`), the wallet reads `/address/:a/txs` for its 40 watched addresses, merges them by txid and works the rest out itself:
  - "Fee, to yourself" when every output is the wallet's;
  - "Deposit to Slot N" for an M5 it funded to the Treasury script of a Slot it supports;
  - "Deposit from the main chain" for a transaction with an input claiming a Deposit (Esplora's `is_pegin`), whose `txid` is that Deposit's;
  - "+ confidential amounts not shown" for its outputs with no explicit value.
- **No paging yet** (#36): History reads only each address's first page (only finding a Deposit's credit pages back, under Deposit). When an address's list is full (25 confirmed or 50 unconfirmed), the screen says older transactions may not be shown.
- **Trust needs each input's parent.** Over Esplora the wallet assumes a parent missing from the lists is confirmed. It paid a watched address, whose list has every one of its mempool transactions (up to 50), so only an older confirmed one can be missing.

## Send

**What the user sees:** home's "Send from" sheet picks a Slot, then `#/send/<slot>` (`send.start`, `send.spendable`). The user adds one or more recipients, in any mix of assets, and each asset shows how much is spendable. After approving, the screen shows the txid and links to the chain's Activity tab (`#/chain/<slot>/activity`). Sends are for Slots only. A Slot's Send button shows when its server speaks `/v1` or its module declares `buildTransfer`.

**Over Esplora** (`wallet/src/send.ts`, #28, ADR 0006), the wallet builds the Send itself:

1. It gathers the **Spendable** coins: confirmed coins, plus outputs of trusted unconfirmed transactions, less held coins.
2. It picks the first unused change address (else `/1/19`) and the fee rate.
3. `elements.wasm`'s `build_transfer` builds the PSET: largest coins first, dust change goes to the fee, and confidential destinations are refused.
4. The module's Clear View goes to the approval window as "This wallet (Send on <chain>)". It must be exactly the payments asked for, plus outputs back to the wallet (`isTransferAskedFor`).
5. After approval: `sign`, `finalize`, `POST /tx`.
6. The coins it spent are **held** in `storage.local` (`held:<txid>`) until it confirms, or until the server hasn't known it for 6 blocks.

**Over `/v1`**, the server builds the transfer. Its Signing Request gets the same validation, Chain Module and approval window as a website's (`wallet/src/signing.ts`), with the server's URL as the requester. It must be Clear Signed, because there's no Grant to opt into Blind Signing, and it must be the transfer asked for. Anything wrong with it is refused as the server's error, without a window. After approval the wallet submits the signed PSET back to the server.

**One Send per Slot at a time**, the wallet's own or a website's (`sendTransfer`, below), so two never pick the same coins.

**A Send that fails after approval:** the toolbar popup closes when the approval window opens, so the screen that asked may be gone. The failure is kept for the session (`send.refused`) and shown in the Activity feed with "Try again" until closed.

## Deposit

**What the user sees:** home's "Deposit to" sheet, or a Slot's own screen, opens `#/deposit/<slot>` (`deposit.start`). A Deposit moves coins from eCash into the Slot.

**How** (`wallet/src/deposit.ts`, #31, ADR 0004):

1. The Slot's Chain Module says what the Deposit credits (`depositDestination`). For Elements, that's its first receive address as UTF-8, with a minimum of 3,000 sats, credited exactly the value.
2. `treasury.ts` finds the Slot's Treasury on eCash's Esplora by #15's strict exactly-one rule (`/scripthash/:h/utxo`, following pending M5s). With none, only a pinned `activation` in the Slot's Chain Entry allows a first Deposit.
3. `l1.wasm`'s `build_deposit` builds the M5 from the account's confirmed coins: largest first, the fee at the 6-block estimate, change to the first unused change address. Every input carries its previous transaction, so the module checks every value itself.
4. The L1 Decoder's Clear View goes to the approval window. After approval: `sign`, `finalize`, `POST /tx`.

**The replay marker:** `l1.wasm` refuses to check, decode, sign or finalize any spend without it: betanet's `nLockTime` 499999999 and a non-final `nSequence`.

**Tracking:** pending Deposits sit in `storage.local` (`deposit:<txid>`) and show under "In progress" on the Activity tabs (`deposit.list`), each with its txid. They go through:

1. "n / N" confirmations, N being the Slot's `depositConfirmations` from its Chain Entry (6 on betanet; BIP300's 100 when absent);
2. waiting for the operator's `importdrivechaindeposit` (the claim arguments are shown);
3. "credited", once the Slot's server lists a transaction to the address (`/address/:a/txs`) with an input claiming the Deposit's txid (`is_pegin`), confirmed or not. Past the first page it pages back (`/txs/chain/:last`), 25 confirmed at a time, until a page ends in a transaction mined below the Slot's tip when the Deposit was sent, less 10 blocks for a reorg (`isCredited`). That height is read just after the broadcast, waiting at most 5 seconds, and kept with the Deposit (`slotHeight`); without it, the tracker pages to the end. Heights, not block times: after a gap in a BMM chain's blocks, a block's time may legally be hours in the past.

A stuck Deposit (its server doesn't know it, or its status can't be read) offers "Stop tracking": the wallet forgets it, and the transaction is unaffected. Healthy ones offer nothing.

**A Deposit that fails after approval** (a refused broadcast, say) is kept for the session (`deposit.refused`), as with Send. The Activity tabs show "Your Deposit of N ECX failed: <reason>" with "Try again" until it's closed (×) or the next Deposit is sent.

## The Provider

What a Sidechain App calls (`wallet/src/provider.ts`). It finds the Provider with `client`'s `discoverProviders()`, then calls `request({ method, params })`.

| Method | Needs a Grant | What it does |
|---|---|---|
| `connect({ slots, methods })` | no | Asks the user for a Grant: these methods on these Slots. |
| `disconnect()` | no | Removes the caller's own Grant. |
| `getGrant()` | no | The caller's own Grant (`connect`'s answer) plus `unlocked`, or `null` without one. Never opens a window. |
| `getAddresses({ slot })` | yes | `[{ chain, address, publicKey }]`: the Slot's receive address, its CAIP-2 chain id, and the 33-byte compressed key the address pays, in hex. Older wallets don't send `publicKey`. While locked, it opens a window to unlock first. |
| `signTransaction(request)` | yes | Signs a Signing Request (a PSET) after approval and returns it signed. It doesn't broadcast. |
| `sendTransfer({ slot, outputs })` | yes | The wallet makes a Send for the app and returns `{ txid }`. |

**Grants** are per origin, stored in `storage.local`, and listed on the Grants screen (`#/grants`), where they can be revoked. The connect prompt also has the **Blind Signing opt-in**, a checkbox that is off by default.

**While locked,** every granted method opens the approval window to unlock first; closing it is 4001. An origin's `getAddresses` calls share its one unlock window (a signing request or Send unlocks in its own approval window). `connect` and `getGrant` need no key, so they work locked. A page can check `getGrant().unlocked` on load and ask for addresses only after a click, so a reload never opens a window. The wallet sends no lock or unlock events: they would tell sites when the user is away.

**Events:** `provider.on("grantChanged", listener)` (and `removeListener`). The listener gets the origin's Grant scope, or `null` once it has none. It fires in every open tab of that origin when the Grant is widened by `connect`, revoked on the Grants screen, or removed by `disconnect`. The background sends it to every tab's top frame (`chrome.tabs.sendMessage`, no tab permission needed), and each content script passes it to its page only if the origin is the page's own.

**Chains that are off:** a request for one turns it on only once the user approves, either in the connect prompt ("Approving also turns on …") or in a `turnOn` prompt first. If the user refuses, 4001.

**Error codes** (EIP-1193 style):

| Code | Meaning |
|---|---|
| 4001 | The user rejected, or closed the window. |
| 4100 | No Grant for this method or Slot. |
| 4200 | Unsupported method or format. |
| 4901 | The wallet has no Chain Module for the Slot. |
| -32602 | Invalid params, or a request the wallet won't sign or build. |
| -32001 | The Sidechain Server failed or refused. |
| -32603 | Internal wallet error. |

### signTransaction

The handler checks a request in this order:

1. **The envelope:** unknown MAJOR version → 4200, unknown fields are ignored, expired → -32602.
2. **The Grant:** Slot and method → 4100.
3. **The Slot's Chain Module's `check`:** a wrong ELIP-101 genesis, any confidential input or output, or inputs without `witness_utxo` → -32602. This needs no Starter, so it runs before any unlock prompt.
4. **`decode`**, after unlocking: an input without `bip32_derivation` that doesn't spend the address `getAddresses` gives out, or a PSET with no input of the wallet's, → -32602 (ADR 0007). Otherwise a Clear View, or Blind with the facts the module can verify. Blind needs the Grant's Blind Signing opt-in (4100 without it).

There is one approval window per request. It asks to unlock first if the wallet is locked, then shows the request. `sign` returns the same PSET with signatures on the inputs that re-derive to the Starter, and nothing else added: an input spending the given-out address gets no `bip32_derivation` entry written back.

### sendTransfer

The wallet's own [Send](#send), for an app (#39, ADR 0006): the app names the outputs, and the wallet picks the coins and change, gets the user's approval, broadcasts it and holds its coins.

- **Its own Grant.** `signTransaction`'s doesn't cover it.
- **The approval window names the app's origin.**
- **Always Clear Signed, never Blind,** even with the Blind opt-in.
- **Addresses only:** each output is `{ asset, amount, to: { address } }`. Any other `to` is refused.
- **Works while locked:** the approval window unlocks first, then shows the transfer.
- **Errors go to the app**, not into Activity:
  - not enough spendable, dust, a confidential address → -32602 over Esplora;
  - over `/v1`, the server's refusals and anything wrong with what it built → -32001.

## Session cache

`wallet/src/cache.ts` keeps a few things in `storage.session` (memory only), mostly to answer faster. It's read and written only while unlocked, and forgotten on every lock:

- a server's passed identity check, once per URL (ADR 0002). A failure is never kept.
- the last balance each chain's server reported (`l1.cached`, `accounts.cached`). It shows at once, marked "Last read at …; refreshing…" (`data-refreshing` on the card) until the fresh one arrives.
- raw transactions, once the L1 module has hashed them to their txid.
- each chain's last history (`history.cached`), shown the same way on the Activity tabs.
- each Slot's last Send or Deposit that failed after approval.

Nothing else a Deposit is built from is cached: its coins, Treasury, fee rate and confirmations are always read fresh.
