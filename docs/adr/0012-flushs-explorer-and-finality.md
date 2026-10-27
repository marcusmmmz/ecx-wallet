# Flush's explorer is its own Server API, and a Flush block is confirmed once anchored

Flush (Slot 99 on betanet, ADR 0014; #56) is read from its explorer, `explorer.blockfab.org/betanet/flush/api`. That explorer is mempool.space's backend, whose electrs fork serves most of what ADR 0002's `"esplora"` covers, plus routes of its own under `/flush/`. Two things about Flush don't fit `"esplora"`:

- **Depth means little.** Flush makes a block of stake every 15 seconds, and such a block stays `soft` until an eCash block anchors it. One anchor can replace any number of soft blocks: block 8,462 was 502 deep and still soft. `/flush/blocks?hashes=a,b,…` (up to 30, comma-separated) says how final each block is: `soft`, `anchored` (one anchor), or `final` (three, about 30 minutes).
- **It can stall without saying so.** Flush halted from 2026-10-24 ~19:00 UTC to the next day, and `getposinfo.stalled` stayed `false` throughout. Only the tip's age showed it.

So the Chain Entry names its server's API as `"flush"`:

```json
"sidechainServer": { "api": "flush", "url": "https://explorer.blockfab.org/betanet/flush/api" }
```

`"flush"` is `"esplora"` with these rules added (`esploraConfig` in `wallet/src/server-api.ts`):

- **Confirmed means anchored.** A transaction in a block short of `anchored` counts as unconfirmed everywhere the wallet reads a status: the balance (it shows as "+N unconfirmed"), the history, which coins a Send may spend, and when a Send's held coins are released. A block known to be `final` isn't asked about again.
- **Stalled** after 5 minutes without a block (`FLUSH_STALL_SECONDS`, 20 slots), from `GET /blocks`'s tip timestamp. The report carries `stalledSince`, and the wallet shows it on home and on Flush's screen.

Some of what the live explorer does differently applies to any Esplora server, so the client now handles it for every chain:

- **Paging:** the history reads up to 3 older pages per address past the first 25 confirmed transactions (`HISTORY_PAGES`). It tries Blockstream's `/txs/chain/:txid` first; mempool's fork 404s there, so after the first 404 the client switches to `?after_txid=` for that server. A history is `partial` only if the pages run out, the mempool list is full, or the server repeats a page.
- **Errors:** a JSON body `{"error": "…"}` is shown as its message, and an HTML page as its HTTP status only.

Flush's module builds from whole transactions (its format is `psbt`, as L1's Deposits are). For a Send the wallet fetches each coin's transaction (`/tx/:txid/hex`), and refuses to go on if the module spends an outpoint the server never listed.

## Considered Options

- **Keep `"esplora"` and let Flush's module declare finality as a capability:** rejected. `/flush/blocks` is the explorer's route, not something the module computes, and a chain served by a plain electrs would have no way to answer.
- **Confirmed at `final`:** not for now. Three anchors take about 30 minutes, three times what an eCash confirmation takes, and the wallet already treats one eCash confirmation as enough elsewhere. Whether wallets should wait for `final` was asked of Flush's developer on 2026-10-25. `CONFIRMED_AT` in `wallet/src/esplora.ts` is the one place to change.
- **Count every block as confirmed, as `"esplora"` does:** rejected. Someone else's payment in a soft block would be spendable, and a replaced block would take it back.
- **A stall threshold of one eCash block (10 minutes):** rejected. Flush's own blocks come every 15 seconds; 5 minutes without one is already 20 missed slots.
- **The explorer's `/flush/status.halted` as the stall signal** (block-fabric/explorer `58882ec`, 2026-10-25): not for now. `halted` is true when blocks of stake have stopped, either because PoS is inactive or because no anchor has covered the chain for `maxUnanchoredSlots` (24 hours). With PoS inactive, Flush still makes BMM blocks, one per eCash block, and they confirm transactions. So `halted` doesn't mean "nothing confirms", which is what "Stalled" tells the user. The tip's age measures that directly. `slotsUntilHalt` could warn before a halt; nothing shows it yet.

## Consequences

- Flush's explorer had no unconfirmed incoming outputs on `/address/*` (recorded 2026-10-25). A payment to the wallet showed only once it was in a block, and a Send's change only then too. Its `58882ec` merges the mempool into `/address/*` and adds Blockstream's `/txs/chain/:txid`, so the client's `?after_txid=` fallback stops being needed. Neither was observable live: the mempool was empty, and `/address/:a/txs*` returned 502 from 2026-10-25 20:16 UTC (#55). Fixed by 2026-10-27, with `POST /tx` now reaching the node.
- A refused broadcast carries the node's code alone (`sendrawtransaction RPC error: {"code":-26}`). The wallet then asks the explorer's `POST /txs/test` (the node's `testmempoolaccept`) for the reason, and shows the code alone if that doesn't answer.
- A Send's held coins are released once its block is anchored, or once the server has forgotten it for 6 blocks (`HOLD_BLOCKS`), which on Flush is 90 seconds.
- If mainnet's Flush (Slot 46) is served by a different explorer, this ADR changes with it.
