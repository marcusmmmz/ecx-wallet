# An asset's name is verified only if its Chain Entry names it

A name the wallet checks against the chain proves only what the asset calls itself. Anyone can write an Elements contract for "USDt", and anyone can register a free Flush ticker, "USDT" included, before its real issuer does. Both pass every check ADR 0010 and ADR 0013 make, and a fake USDT sent to the user would then look like the real one.

So every screen that names an asset puts a badge after its ticker (`assetTrust`, `app/src/lib/AssetBadge.svelte`):

- **Verified (a check mark):** its Chain Entry names it. The wallet ships that list, so it is the wallet's own word.
- **Not verified (a warning):** a name from the asset's contract (`contract`) or registration (`registration`), a name an app suggested (`app`), or an unknown asset. The tooltip says anyone can make an asset with any name, and to check its id.
- **No badge:** ECX, which has eCash's own mark; the user's own label (`label`); an asset the user issued themselves (`signed`).

The badge shows on home's asset rows, Activity amounts, the approval window's outputs and the Assets screen. A Send's asset menu can hold text only, so there an unverified name reads "⚠ USDT (not verified)" and a verified one "USDT ✓".

## Considered options

- **Treat a checked contract or registration as verified:** rejected. The check binds the name to the asset id, not to the issuer the user has in mind.
- **Refuse names that collide with well-known tickers:** rejected for now. The wallet would need a list of them, and that list is what the Chain Entry already is.
- **A badge on a label too:** rejected. The user chose that name, so a badge would add nothing.

## Consequences

- Today no Chain Entry names an asset besides ECX, so no check mark shows yet. Adding a well-known asset to a Chain Entry is how it becomes verified.
- A user who wants a name without the warning can label the asset themselves. Removing a contract's or registration's name first makes room for a label (ADR 0010).
