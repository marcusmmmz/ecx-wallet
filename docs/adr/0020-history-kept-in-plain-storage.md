# History is kept in plain storage, and paged further on request

Over Esplora, history is read address by address: the first page of each watched address's transactions and up to `HISTORY_PAGES` older ones (ADR 0012). The wallet's receive address never changes (`APP_RECEIVE_ADDRESSES`), so a busy wallet's transactions pile up on one address, and its history stopped at the latest 100 to 125, re-read in full on every open, with no way to see further.

So each address's settled history is kept for good, and the Activity tab can read further back:

- **What's kept:** per server and address (`cacheKey.addressHistory`), the address's confirmed transactions as the wallet reads them (`KeptHistory`), from the newest one no reorg should undo back to the oldest read, and whether that's the address's first (`end`). No reorg should undo a transaction `KEPT_DEPTH` (10) blocks deep, the margin a Deposit's credit allows, or on Flush one in a `final` block. Newer ones are read again every time.
- **Reading:** history reads back from the newest page only until a page lists a kept transaction, then adds the kept ones after it. If no page does within `CATCH_UP_PAGES` (40), or the list ends first, the server no longer lists what was kept (a deeper reorg, or another chain at that URL), and it reads as if it had kept none, and keeps that instead.
- **Show older:** under "Older transactions may not be shown", it reads up to `HISTORY_PAGES` more pages per address past the oldest read (`history.reported` with `older`), and keeps them too.
- **Where:** `host.persistent`, in plain text: `storage.local` in the extension, IndexedDB in the web build. That's where pending Deposits and Flush's final trade outcomes (ADR 0017) already are.

## Considered options

- **Session cache only** (`storage.session`, forgotten on lock): rejected. Every unlock would page through the whole history again, and what "Show older" read would be lost.
- **Encrypted at rest**, under a key derived from the vault key: rejected (2026-10-31). It hides which addresses are the wallet's from someone reading the browser profile, but extension wallets broadly keep history in plain text (MetaMask and Rabby keep all but the keyring so), and pending Deposits already are.
- **A separate IndexedDB database in the extension**, for room past `storage.local`'s 10 MB in Chromium: not needed yet. A transaction as kept is a few hundred bytes, so thousands fit. A failed write only costs paging next time.
- **Showing a new receive address each time**, so transactions don't pile up on one: a separate decision. It needs a gap-limit scan past the 20 watched addresses.
