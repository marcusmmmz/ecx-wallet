# How it works

One section per feature: what the user sees, then how the wallet does it, with the names to search the code for. Terms are defined in [GLOSSARY.md](../GLOSSARY.md); the reasons behind each design are in [docs/adr/](adr/).

- [The request path](#the-request-path)
- [Vault](#vault)
- [Accounts and keys](#accounts-and-keys)
- [Sidechain Servers](#sidechain-servers)
- [Home: balances and chains](#home-balances-and-chains)
- [History](#history)
- [Assets](#assets)
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
- The approval window is the app page at `#/approve/<id>` (`app/src/lib/Approval.svelte`). It talks to the background only through `runtime.sendMessage`.
- **The wallet's own Send and Deposit approve in place.** The toolbar popup closes whenever another window takes focus, so those screens don't open a window: each connects a port (`approval.host:<host>`, `hostApprovals`) and passes `host` with its request, and the background posts the approval's id on that port. The screen then shows the same `Approval` component where its form was. Closing the popup disconnects the port, which rejects the request, as closing an approval window does. An app's request, and a `/v1` server's, still get a window.
- Wallet pages (home, Send, Settings…) talk to the background the same way, one message kind per action (`vault.*`, `send.start`, `history.reported`…). The extension's router is in `extension/src/background.ts`.

## Vault

**What the user sees:** onboarding creates or imports a wallet (`#/create`, `#/import`). The wallet then locks after 15 minutes without use, and the home header counts down ("Locks in 15 min"). Settings (`#/settings`) has Grants, Chains, Assets, the ECX/sats unit, the auto-lock delay (shown only) and Lock now.

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

Each chain is read from the Sidechain Server its Chain Entry names for the module's network, in the Server API named next to the URL: `sidechainServer: { api, url }` (ADR 0002). All three speak Esplora; Flush's explorer adds finality (`"flush"`, ADR 0012):

| Chain | Server (betanet) | Chain Entry |
|---|---|---|
| eCash | `https://esplora.beta.ecash.ninja` | `core/l1/chain-entry.json` |
| Slot 24 | `https://explorer.bitnames.info/api` | `core/elements/chain-entry.json` |
| Slot 99 (Flush on betanet, ADR 0014) | `https://explorer.blockfab.org/betanet/flush/api` | `core/flush/chain-entry.json` |

The extension build turns those URLs into `host_permissions` and the CSP's `connect-src`. `wallet/src/server-api.ts` picks the client for the Server API.

### Esplora (`wallet/src/esplora.ts`)

- **Identity check:** the wallet first checks `/block-height/H` against the Chain Entry's `identityBlock`. For Elements that's height 0, the genesis. eCash betanet's genesis is Bitcoin's, so it uses its fork block, 967,680 (ADR 0003). A mismatch is a hard error, and so is a server that hasn't reached H.
- **Balance:** the sum of the explicit outputs (`/address/:a/utxo`) of the first 20 receive and 20 change addresses, per asset, with confirmed and unconfirmed kept apart. eCash's outputs have no asset: they're its coin (`NATIVE_COIN`), shown in sats.
- electrs already leaves out outputs its mempool spends. So a Deposit's coin leaves the confirmed balance at once, and its change shows as unconfirmed.
- Lookups run 20 at once (`QUERIES_AT_ONCE`).
- **Flush** (`"flush"`, ADR 0012): any block confirms (`CONFIRMED_AT`), and one no eCash block anchors yet (`soft`, from `/flush/blocks`) is **preconf**: it counts and can be spent, home shows "N preconf" under the balance (`preconfirmed`), and Activity marks the transaction "Preconf". Five minutes without a block (`FLUSH_STALL_SECONDS`) shows "Stalled" on home and a notice on Flush's screen. Its explorer lists no unconfirmed incoming outputs.
- **Flush tokens** (ADR 0013): a coin of value 0 is read from the transaction that made it (`/tx/:txid/hex`, cached for the session). `flush.wasm`'s `output_tokens` says which token its `BAST` marker lists on it, and the txid it computes must be the coin's. An asset token counts towards that asset's balance; other token kinds (control coins, LP shares, positions, orders) don't. A **result** output (a swap's, a pool withdrawal's) carries a token no transaction states: for an address holding one, `/flush/market/addresses/:a/holdings` gives what it holds beyond the tokens the wallet read, and Home shows that apart, as "+N reported by its server".
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
- **Names** come from the Chain Entry: the chain ("Main chain", "Elements+") and its assets (`chains.list`).
- **The asset store** (`wallet/src/assets.ts`, ADR 0010) names other assets, one store per network in plain `storage.local` (`assets:<chain>`). It holds an asset the wallet signed a new issuance of, with a checked contract (`signed`), one the user added by its contract (`assets.addByContract`, `contract`), a Flush asset added from its registration (`assets.addByRegistration`, `registration`, ADR 0013), or one the user labelled (`label`). Adding by contract reads the issuance's outpoint from Esplora's `/asset/:id`, and `elements.wasm`'s `asset_contract` derives the asset id from it and the contract's hash. A ticker of the Chain Entry's, in any case, is refused. Where it matters (the Assets screen, Activity details, the approval window), a stored name is marked "from its contract", "from its registration" or "your label", with the asset's id. Home's balance rows show only its ticker and name. Any other asset is "Unknown asset". The [Assets](#assets) screen manages the store.
- **A chain's own screen** (`#/chain/<l1|slot>`) says "Reported by <server URL>".
- **Units:** every ECX amount follows one unit, ECX or sats (`formatAmount`; `settings.unit`, kept in `storage.local`). Tapping the total switches it.

**Chains on and off:** sidechains start off (`settings.chainOn`, per chain id in `storage.local`). The Chains screen (`#/chains`, `chains.setOn`) turns them on. A chain that's off is hidden, left out of the total, Send and Receive, and the background refuses to read it ("<name> is turned off."). Its Deposits in progress still show. The main chain is always on.

## History

**What the user sees** (#33): the Activity tabs. Home's merges every chain that's on, with a chip per chain to filter. Each chain's screen has its own.

- **Order:** Deposits in progress first, then "Not yet confirmed", then one section per day (`activityDays`).
- **Each row** says what the transaction did (`activityKind`: Received, Sent, "Fee, to yourself", "Deposit to <chain>", "Deposit from the main chain", "Asset issuance", "Asset reissuance"), and the wallet's net change per asset, fee included, each amount with its asset's mark and in red when it left the wallet. Then its time, or a badge:
  - **Pending:** trusted. It spends only the wallet's own coins, each confirmed or from a trusted transaction.
  - **Unconfirmed:** anything else, with a warning (for a Deposit's credit: the operator credited it, not in a block yet).
- **A Flush trade** (ADR 0017) is one row twice as tall: its title by outcome (Sold, Bought, "Selling" while its payout is queued, "Sale didn't fill"), its time, and what it gave above, with the fee under it; what came back below ("Paid", "Received", "Refunded", "Returned", a queued payout greyed with "≈"; before an outcome, "Settles once it's in a block", "Waiting for the market's index" or "Couldn't read the outcome"). Beside them, the asset given, a down arrow and the asset back. An amount only the market index vouches for is underlined dotted.
- **Tapping a row** shows its status, when it was mined, the chain and its id, the txid with Copy, a Deposit's credit's main-chain txid, and who reported it. A trade's shows "You gave" with its fee and price, what came back, the coinbase that paid it, its pool, and Retry when its outcome couldn't be read.

**How:**

- History is read only when a tab is first opened: `history.reported` per chain, in parallel. This session's last one (`history.cached`) shows while it refreshes. A chain that fails says so with Retry; the others still show.
- **Over Esplora** (`SidechainServer.history`), the wallet reads `/address/:a/txs` for its 40 watched addresses, merges them by txid and works the rest out itself:
  - "Asset issuance" (or "Asset reissuance") when an input of the wallet's issues an asset (Esplora's `issuance` on Elements), ahead of "Fee, to yourself";
  - "Fee, to yourself" when every output is the wallet's;
  - "Deposit to Slot N" for an M5 it funded to the Treasury script of a Slot it supports;
  - "Deposit from the main chain" for a transaction with an input claiming a Deposit (Esplora's `is_pegin`), whose `txid` is that Deposit's;
  - "+ confidential amounts not shown" for its outputs with no explicit value;
  - on Flush, a value-0 coin it pays or spends counts as the asset token its creating transaction's marker lists, read by the module's `outputTokens` as the balance reads it (ADR 0013). A trade's row shows the tokens that left, its change netted. A coin the marker lists as a result adds "+ amounts only the node knows not shown" (`results`): what it carries is in the node's state;
  - a Flush trade through one pool, funded by the wallet and paying ECX to one of its addresses, gets `trade` (`wallet/src/flush-trades.ts`, ADR 0017). Its outcome comes from the market index (`/flush/market/pools/:id/trades`, paged back to its block): a fill, or a miss once the index (`/flush/market/status`) has passed its block. ECX coming back is the earliest unclaimed coinbase output to the order's `chn_to` of exactly that amount, at or after the trade's block, folded into the trade's entry; until then the payout is queued. The index's answer is cached for the session, and in `storage.local` once the trade's block is final.
- **Paging:** History reads up to 3 older pages of an address's confirmed transactions past the first 25 (`HISTORY_PAGES`), with Blockstream's `/txs/chain/:txid` or, on mempool's fork (Flush's explorer), `?after_txid=` (ADR 0012). When pages remain past those, the mempool's list is full (50), or the server repeats a page, the screen says older transactions may not be shown.
- **Trust needs each input's parent.** Over Esplora the wallet assumes a parent missing from the lists is confirmed. It paid a watched address, whose list has every one of its mempool transactions (up to 50), so only an older confirmed one can be missing.

## Assets

**What the user sees** (#51): Settings → Assets (`#/assets`) lists the asset store's entries for each sidechain that's on, each with its ticker, name, source ("from its contract", "from its registration" or "your label"), full id and decimal places. From there the user can:

- **Add by contract:** paste an asset id and its contract JSON (`assets.addByContract`). The wallet checks it against the chain as under [Home](#home-balances-and-chains) and refuses a mismatch, saying why.
- **Add from its registration** (Flush, in place of a contract): paste an asset id (`assets.addByRegistration`). The node's `getasset` (`/flush/rpc/getasset`) names the transaction that registered it and the height. The wallet checks that transaction is confirmed at that height, and `flush.wasm`'s `asset_registration` checks it registers this asset under a ticker whose SHA-256 is the id. The ticker, decimals and name (its display name, or else the ticker) come from that registration (ADR 0013).
- **Add a label** for an asset with no contract: a name, ticker and decimal places (`assets.label`), held to the registry's rules for a contract's name and ticker. It can't replace a name from the asset's contract: remove that first.
- **Rename a label** or a name an app suggested ([`suggestAsset`](#suggestasset), marked "named by <origin>"), which makes it the user's label. **Remove** any entry (`assets.remove`). Removing only forgets the name, and the asset shows as "Unknown asset" again.

A ticker of the Chain Entry's, in any case, is refused, with the reason shown. An "Unknown asset" on Home's rows or in an Activity transaction's details has "Name it", which opens `#/assets/<slot>/<asset>` with the form ready for that asset. The approval window has no such link, since leaving it would abandon the request.

**How:** `assets.list`, `assets.label` and `assets.remove` take a Slot and work on its network's store (`wallet/src/assets.ts`). On Flush, the app names each unnamed asset a report shows by itself (`assets.nameFromRegistrations`, once per asset per session in the background), with its logo if `getasset` names a SetLogo that checks out (ADR 0013); home shows the logo in place of the ticker's first letter. Only `assets.addByContract`, `assets.addByRegistration` and `assets.nameFromRegistrations` read the chain, so they need the chain on and an Esplora server (Flush's explorer, for a registration).

## Send

**What the user sees:** home's "Send from" sheet picks a Slot, then `#/send/<slot>` (`send.start`, `send.spendable`). The user adds one or more recipients, in any mix of assets, and each asset shows how much is spendable. After approving, the screen shows the txid and links to the chain's Activity tab (`#/chain/<slot>/activity`). Sends are for Slots only. A Slot's Send button shows when its server speaks `/v1` or its module declares `buildTransfer`.

**Over Esplora** (`wallet/src/send.ts`, #28, ADR 0006), the wallet builds the Send itself:

1. It gathers the **Spendable** coins: confirmed coins, plus outputs of trusted unconfirmed transactions, less held coins.
2. It picks the first unused change address (else `/1/19`) and the fee rate.
3. The Slot's module builds it (`build_transfer`): largest coins first, dust change goes to the fee. `elements.wasm` builds a PSET from the coins as reported, and refuses confidential destinations. `flush.wasm` builds a PSBT from each coin's whole transaction (`/tx/:txid/hex`) and pays at least 1 sat/vB. A Send of ECX never spends a value-0 output. A Send of an asset spends only confirmed coins carrying that asset, as their transactions' markers say, and lists its tokens with a transfer marker (ADR 0013). The wallet refuses to go on if it spends an outpoint the server never listed.
4. The module's Clear View is shown in place, on the Send screen, as "This wallet (Send on <chain>)". It must be exactly the payments asked for, plus outputs back to the wallet (`isTransferAskedFor`).
5. After approval: `sign`, `finalize`, `POST /tx`. If Flush's explorer refuses with the node's code alone, the reason comes from `POST /txs/test`. A Send passes no `?maxburnamount=`, so the node refuses any value in an `OP_RETURN` output; only a Flush DEX action allows its marker's ECX (ADR 0016).
6. The coins it spent are **held** in `storage.local` (`held:<txid>`) until it confirms (on Flush: any block, preconf included), or until the server hasn't known it for 6 blocks.

**Over `/v1`**, the server builds the transfer. Its Signing Request gets the same validation, Chain Module and approval window as a website's (`wallet/src/signing.ts`), with the server's URL as the requester. It must be Clear Signed, because there's no Grant to opt into Blind Signing, and it must be the transfer asked for. Anything wrong with it is refused as the server's error, without a window. After approval the wallet submits the signed PSET back to the server.

**One Send per Slot at a time**, the wallet's own or a website's (`sendTransfer`, below), so two never pick the same coins.

**A Send that fails after approval:** the screen that asked may be gone by then (the user closed the popup). The failure is kept for the session (`send.refused`) and shown in the Activity feed with "Try again" until closed.

## Deposit

**What the user sees:** home's "Deposit to" sheet, or a Slot's own screen, opens `#/deposit/<slot>` (`deposit.start`). A Deposit moves coins from eCash into the Slot.

**How** (`wallet/src/deposit.ts`, #31, ADR 0004):

1. The Slot's Chain Module says what the Deposit credits (`depositDestination`). For Elements, that's its first receive address as UTF-8, with a minimum of 3,000 sats, credited exactly the value. For Flush, it's `s99_<address>_<checksum>` on betanet (the checksum is the first 6 hex digits of the SHA-256 of `s99_<address>_`), with a minimum of 294 sats; `flush.wasm` declares it only while its Chain Entry pins its Slot's activation (ADR 0004).
2. `treasury.ts` finds the Slot's Treasury on eCash's Esplora by #15's strict exactly-one rule (`/scripthash/:h/utxo`, following pending M5s). With none, only a pinned `activation` in the Slot's Chain Entry allows a first Deposit.
3. `l1.wasm`'s `build_deposit` builds the M5 from the account's confirmed coins: largest first, the fee at the 6-block estimate, change to the first unused change address. Every input carries its previous transaction, so the module checks every value itself. It refuses an M5 eCash won't relay: over 10,000 vB, or over 1,000 vB when the Treasury it spends is a pending M5's, and a destination over 100 bytes (Backbone's limits, #57).
4. The L1 Decoder's Clear View is shown in place, on the Deposit screen. After approval: `sign`, `finalize`, `POST /tx`.

**The replay marker:** `l1.wasm` refuses to check, decode, sign or finalize any spend without it: betanet's `nLockTime` 499999999 and a non-final `nSequence`.

**Tracking:** pending Deposits sit in `storage.local` (`deposit:<txid>`) and show under "In progress" on the Activity tabs (`deposit.list`), each with its txid. They go through:

1. "n / N" confirmations, N being the Slot's `depositConfirmations` from its Chain Entry (6 on betanet; BIP300's 100 when absent);
2. waiting for the operator's `importdrivechaindeposit` (the claim arguments are shown), or on Flush, which pays Deposits itself, for its payout;
3. "credited", once the Slot's server lists a transaction to the address (`/address/:a/txs`) with an input claiming the Deposit's txid (`is_pegin`), confirmed or not. Past the first page it pages back (`/txs/chain/:last`), 25 confirmed at a time, until a page ends in a transaction mined below the Slot's tip when the Deposit was sent, less 10 blocks for a reorg (`isCredited`). That height is read just after the broadcast, waiting at most 5 seconds, and kept with the Deposit (`slotHeight`); without it, the tracker pages to the end. Heights, not block times: after a gap in a BMM chain's blocks, a block's time may legally be hours in the past. On Flush, nothing names the M5: its credit is a coinbase output after the first paying the address exactly the Deposit's value, in a block above `slotHeight`, that no other Deposit has claimed (`flushCredit`). Deposits are matched oldest first, as Flush pays them in eCash order. The matched output is kept with the Deposit, which stays listed as credited while another Deposit of the same value to the same address waits.

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
| `sendAction({ slot, action })` | yes (`sendTransfer`'s) | The wallet builds the chain's action (on Flush, the trade a `flush:` link asks for) and returns `{ txid }`. See below. |
| `suggestAsset({ slot, asset, contract \| label })` | yes | Suggests a name for an asset; once the user approves, returns what the wallet stored. See below. |

**Grants** are per origin, stored in `storage.local`, and listed on the Grants screen (`#/grants`), where they can be revoked. The connect prompt also has the **Blind Signing opt-in**, a checkbox that is off by default.

**While locked,** every granted method that needs a key opens the approval window to unlock first; closing it is 4001. `suggestAsset` needs none. An origin's `getAddresses` calls share its one unlock window (a signing request or Send unlocks in its own approval window). `connect` and `getGrant` need no key, so they work locked. A page can check `getGrant().unlocked` on load and ask for addresses only after a click, so a reload never opens a window. The wallet sends no lock or unlock events: they would tell sites when the user is away.

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
| -32002 | The origin already has a request of this kind waiting for the user (`suggestAsset`). |

### signTransaction

The handler checks a request in this order:

1. **The envelope:** unknown MAJOR version → 4200, unknown fields are ignored, expired → -32602.
2. **The Grant:** Slot and method → 4100.
3. **The Slot's Chain Module's `check`:** a wrong ELIP-101 genesis, any confidential input or output, or inputs without `witness_utxo` → -32602. This needs no Starter, so it runs before any unlock prompt.
4. **`decode`**, after unlocking: an input without `bip32_derivation` that doesn't spend the address `getAddresses` gives out, or a PSET with no input of the wallet's, → -32602 (ADR 0007). Otherwise a Clear View, or Blind with the facts the module can verify. Blind needs the Grant's Blind Signing opt-in (4100 without it). A new issuance is Clear: the window shows the asset and token ids the Decoder derives, in base units, and the contract hash. With the contract in the request's `evidence` (`{ assetContract: { "<input>": "<contract JSON>" } }`), the module checks it against the committed hash and the registry's rules, and the window shows the amount in its ticker and precision; evidence that doesn't check out → -32602 (ADR 0009). Once signed, such an asset goes into the asset store, unless its ticker is one of the Chain Entry's (ADR 0010). A reissuance stays Blind (ADR 0008). Blind facts list what leaves the wallet and, separately, what comes into it: the module returns a single per-asset `totalLeaving`, and the window shows its negative amounts, without the sign, under "Coming into your wallet".

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

### sendAction and `window.flush`

A chain's action, built by the wallet (#60, ADR 0016). On Flush, `action` is a `flush:` link as flush.markets writes it: a `swap`, `buy` or `sell` (any other Flush action is 4200). `sendTransfer`'s Grant covers it.

**`window.flush`**: flush.markets finds a wallet only there, so the in-page script also defines `window.flush` (`isFlush: true`, and `request({ method, params })` for its two methods), unless the page already has one. Both go through the same relay as the Provider:

- `flush_requestAddress` → `{ network: "ecashbeta", address }`: the given-out address of the Flush Slot on the wallet's network, with the network as a link names it. It's the site's first call, so without a Grant it asks for one (`getAddresses` and `sendTransfer` on that Slot).
- `flush_submit({ uri })` → `{ txid }`: `sendAction` on that Slot.
- A rejection reads exactly "User rejected.", which the site takes quietly; any other error's message is shown to the user there.

**The trade** (`wallet/src/send.ts`, `trade`), in the Slot's queue with its Sends:

1. The module reads the link (`parseAction`): its version, network and expiry as Flush's own app checks them. A link that already ran this session is refused: its SHA-256 is kept in `storage.session`.
2. From the explorer: the node's quote (`getswapquote`; a buy or sale trades on the launch's curve), the pool (`getpool`), each token's registration transaction (`getasset`'s `registration`) and the least ECX the node pays out (`getbitassetsinfo`). A server failure here is -32001.
3. After unlocking, the module builds it (`buildTrade`) from the account's coins: one `swap_pools` marker through the pool, its result, token change and `chn_to` at the given-out address. It recomputes the pool's id from what the explorer reported, takes the token's decimals from its checked registration, and refuses a floor the quote doesn't meet or one more than 10% below it (-32602).
4. The Decoder explains it with the pool as evidence; anything but a Clear View of exactly the trade built, every output back to the wallet, is a wallet bug, refused before the user sees it. The approval shows the trade: what goes in, at least what comes out with the node's quote, where it goes, and when the link expires.
5. It's broadcast with `?maxburnamount=` the ECX its marker carries, its coins are held as a Send's, and the link is kept as run.

### suggestAsset

An app suggests the name the wallet shows for an asset on a Slot (ADR 0010), like Ethereum's `wallet_watchAsset`. It needs its own Grant.

- **By its contract** (`contract`, its exact JSON): checked against the chain as Add by contract is (Esplora's `/asset/:id` and `elements.wasm`'s `asset_contract`). Approved, it's stored as `contract`, marked "from its contract", with the app's origin kept.
- **As a plain name** (`label: { name, ticker, precision }`): held to a label's rules. Approved, it's stored as `app`, marked "named by <origin>". It can't replace a name from the asset's contract. The user can rename it on the Assets screen, which makes it their own label.
- **Refused before any window** (-32602): a contract that isn't the asset's, a ticker of the Chain Entry's in any case, a plain name for an asset its contract already names, or neither or both of `contract` and `label`. No Grant → 4100.
- **The window** shows the origin, the ticker, name, decimal places and full id, whether the contract was checked, and what the name replaces, if anything. It also shows how much of the asset the wallet holds, confirmed and unconfirmed, in the suggested ticker and precision (`reportedState`, read fresh). While locked it says the balance isn't shown, rather than asking to unlock. Reject or close → 4001.
- **One at a time per origin:** another suggestion while one waits → -32002. It needs no key, so it works while locked.

## Session cache

`wallet/src/cache.ts` keeps a few things in `storage.session` (memory only), mostly to answer faster. It's read and written only while unlocked, and forgotten on every lock:

- a server's passed identity check, once per URL (ADR 0002). A failure is never kept.
- the last balance each chain's server reported (`l1.cached`, `accounts.cached`). It shows at once, marked "Last read at …; refreshing…" (`data-refreshing` on the card) until the fresh one arrives.
- raw transactions, once the L1 module has hashed them to their txid.
- each chain's last history (`history.cached`), shown the same way on the Activity tabs.
- each Slot's last Send or Deposit that failed after approval.

Nothing else a Deposit is built from is cached: its coins, Treasury, fee rate and confirmations are always read fresh.
