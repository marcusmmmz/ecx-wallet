# ECX Wallet

A browser wallet for eCash (ECX) and its drivechains, built as one shared base that each sidechain's maintainers extend from their own side.

## Language

### Wallet

**Wallet Base**:
The shared browser wallet every user runs: it holds keys, signs, presents the UI, and handles the eCash mainchain.
_Avoid_: Core wallet, host wallet

### Keys

**Vault**:
The part of the Wallet Base that keeps the Master Mnemonic encrypted, unlocks it, and derives Starters from it; the only part that ever sees the Master Mnemonic.
_Avoid_: Keystore, keyring, secret store

**Master Mnemonic**:
The single BIP39 phrase a user backs up; the root of their L1 keys and of every Starter.
_Avoid_: Seed phrase, recovery phrase, master seed

**Starter**:
The per-Slot mnemonic derived from the Master Mnemonic, from which one sidechain's keys are derived by that chain's own rules.
_Avoid_: Sidechain seed, child mnemonic, sub-wallet

**L1 Account Key**:
The BIP84 account key (`m/84'/0'/0'`) the Vault derives from the Master Mnemonic and hands to the L1 Chain Module, from which every eCash address is derived; never a Starter, and never given to a Slot's module.
_Avoid_: L1 root, L1 seed, mainchain key

**View Key**:
The private blinding key that reveals the hidden amounts of a user's confidential outputs on a sidechain.
_Avoid_: Blinding key (ambiguous: also names the public half), viewing key

### Sidechains

**Main chain**:
eCash itself, the root of the chain tree, as the Wallet Base names it to users.
_Avoid_: eCash (on screen: it also names the coin and the brand), mainchain, Betanet (the network, not the chain)

**ECX**:
The coin of eCash, and on a sidechain the asset its Chain Entry names as that chain's ECX; the Wallet Base adds these up as one total across chains.
_Avoid_: eCash (for the coin, on screen), policy asset (Elements' word for its ECX), peg asset

**Slot**:
The BIP300 number (1–255) that identifies a sidechain on one eCash network. The same chain can have a different Slot on each network (Flush: 99 on betanet, 46 on mainnet).
_Avoid_: Sidechain number, sidechain id

**Treasury**:
The single eCash output holding all coins deposited to a Slot and not yet withdrawn.
_Avoid_: CTIP (BIP300's name for it), escrow

**Deposit**:
Moving coins from eCash into a sidechain by paying them into its Treasury.
_Avoid_: Peg-in

**Replay marker**:
What makes an L1 spend valid on eCash only: the network's `nLockTime` and a non-final `nSequence` on every input. The wallet signs no L1 spend without it.
_Avoid_: Replay protection (the property, not the marker), coin split

**Activation**:
The parent-chain block whose M2 made a Slot active, pinned in its Chain Entry once checked. The wallet needs it to make a Slot's first Deposit.
_Avoid_: Activation height (it's a block: height and hash)

**Withdrawal**:
Moving coins from a sidechain back to eCash, paid out of its Treasury once miners approve it over several months.
_Avoid_: Peg-out

**Chain Entry**:
The description of one chain, eCash itself or a sidechain, that ships with a Wallet Base release: its name and what it's for, and its networks, on each its Slot and parent chain (neither for eCash, the root), identity block, Activation (for a Slot, once pinned), the main-chain confirmations before a Deposit to it is credited (for a Slot), default Sidechain Server, Official Apps and the assets it names, among them the chain's ECX.
_Avoid_: Chain manifest, chain descriptor, network profile

**Asset Store**:
The assets the Wallet Base names on a network beyond its Chain Entry's: each one it signed a new issuance of with a checked contract, added by a contract checked against the chain, or labelled by the user. Never with a ticker of the Chain Entry's, and always shown as not this release's own names (docs/adr/0010).
_Avoid_: Asset registry (Liquid's, fetched from a server), token list

**Spendable**:
What a Send on a chain can spend now, per asset: confirmed coins, plus change from the wallet's own unconfirmed transactions that only it could replace, less coins a pending Send already spent (docs/adr/0006).
_Avoid_: Available balance

**Finality**:
How settled a block is on a chain that reports it, as Flush's explorer does: `soft` until an eCash block anchors it, `anchored` by one anchor, `final` by three. It doesn't decide what is confirmed: on Flush a transaction confirms at depth 2, once a block is on top of its own (`FLUSH_CONFIRMATIONS`), whatever its block's finality. Finality only marks what the wallet keeps for good, such as a trade's outcome (docs/adr/0012).
_Avoid_: Confirmations, depth (those say when a transaction confirms; a deep Flush block can still be soft), Preconf (the wallet's word for a transaction in a `soft` block until 2026-10-28)

**Indexed**:
The part of a Flush balance that a trade's outcome names: a result output, whose token no transaction states, counted once `/flush/market/trades/:txid` names it and the order's marker agrees (a fill pays another asset, at least `min_out`; a miss refunds exactly what went in). Shown apart, its amount underlined dotted; it can't be spent yet (docs/adr/0013, 0018).
_Avoid_: Unverified (what only `holdings` reports, beyond what the wallet counted), verified

**Stalled**:
What the Wallet Base shows for a chain that has made no block for longer than its Server API allows (5 minutes on Flush), measured from the age of the chain's tip: nothing on it confirms until it moves again.
_Avoid_: Halted (Flush's own word, for a different condition), down, offline

**Sidechain Server**:
A server, by default run by a sidechain's maintainers, from which the Wallet Base reads that chain's state over the Server API its Chain Entry names; over the Standard Sidechain API it also builds unsigned payloads for the Wallet Base to sign and broadcasts the signed ones. Over Esplora the Wallet Base builds and broadcasts them itself.
_Avoid_: Adapter, backend, sidechain plugin

**Server API**:
The protocol the Wallet Base speaks to a Sidechain Server, named next to its URL in the Chain Entry: the Standard Sidechain API, or an existing indexer API the Wallet Base supports (Esplora).
_Avoid_: Backend type, server kind

**History Entry**:
A transaction touching the addresses the Wallet Base watches on one chain, shown as the wallet's net change per asset (fee included), pending or confirmed, as reported by the chain's Sidechain Server. A pending one is trusted when it spends only the wallet's own coins, each confirmed or from a trusted transaction. A Flush trade's entry also holds the coinbase outputs that paid it (its payout or refund, and a launch buy's ECX back), which nothing on the chain links to it: the wallet pairs them (ADR 0017, 0018).
_Avoid_: Activity, transfer (a Standard Sidechain API build request)

**Standard Sidechain API**:
The HTTPS + JSON API this project defines (`/v1`) for a sidechain with no existing indexer: register watch data, read reported state, build a transfer as a Signing Request, submit the signed payload.
_Avoid_: Sidechain Server API (reads as "any API a Sidechain Server speaks"), pull API

**Sidechain App**:
A sidechain's own web UI that asks the Wallet Base to sign for that chain's specific features.
_Avoid_: dApp, frontend, sidechain website

**Official App**:
A Sidechain App whose web origin its sidechain's Chain Entry lists as belonging to that chain's maintainers.
_Avoid_: Verified app, trusted app

**Provider**:
The object the Wallet Base exposes to Sidechain Apps, through which they connect, ask for Grants, and send Signing Requests.
_Avoid_: Wallet API, bridge, connector

**Grant**:
A user's stored approval letting one Sidechain App, identified by its web origin, request certain methods on certain Slots.
_Avoid_: Permission, connection, session

**Action**:
A Sidechain App's request that the Wallet Base build and send a transaction doing something its chain defines, such as a swap on Flush (a `flush:` URI), rather than paying a list of outputs (docs/adr/0016).
_Avoid_: Intent, flush link, order (a Flush order is one kind of Action)

### Signing

**Signing Request**:
A request, from a Sidechain Server or Sidechain App, for the Wallet Base to sign a transaction or message with the user's keys.
_Avoid_: Sign request, transaction request, blob

**Sign-In**:
A Signing Request in which a Sidechain App asks the user to prove control of an address to that App's own origin.
_Avoid_: Login, auth signature

**Blind Signing**:
Approving a Signing Request without the Wallet Base being able to show the user what it means.

**Clear Signing**:
Approving a Signing Request after the Wallet Base has shown the user a decoded, human-readable account of what it does.

**Chain Module**:
The per-chain unit bundled in the Wallet Base that derives a chain's keys from its Starter, decodes its Signing Requests, and signs them.
_Avoid_: Signer module, plugin, adapter

**Clear View**:
The structured, chain-neutral account of a Signing Request that a Decoder produces and the Wallet Base renders for Clear Signing.
_Avoid_: Preview, summary, decoded transaction

**Floor**:
The least an Action may return, which the Wallet Base checks against its own quote before showing it.
_Avoid_: Minimum out, slippage limit

**Evidence**:
Data a Signing Request carries, keyed by kind, that its Chain Module checks against the payload before the Clear View shows anything from it, refusing the request if it doesn't check out (e.g. an asset's contract, against the hash its issuance commits to). Unlike hints, it can change the outcome.
_Avoid_: Proof, attachment, metadata

**Decoder**:
The part of a Chain Module that turns its chain's Signing Requests into a Clear View.
_Avoid_: Parser, interpreter, renderer
