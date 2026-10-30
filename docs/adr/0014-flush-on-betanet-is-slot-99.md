# Flush on betanet is Slot 99, and Slot 46 is mainnet's

Amended by ADR 0019: the Slot is now per network, and Flush's Chain Entry has a mainnet network, Slot 46.

Flush's own Slot is 46 (#55). On betanet, Slot 46 has not been proposed and there are no plans to propose it: Flush gets Slot 46 on mainnet. Betanet's Flush is the chain in Slot 99, the Slot voted in for the "Photon" sidechain, which Flush's node runs as a temporary chain (`getblockchaininfo` warns: "it will be dropped when Flush gets its own slot (46). Do not keep value here."). Flush's explorer serves that chain at `explorer.blockfab.org/betanet/flush/api`, and the explorer will keep serving Flush there.

So Flush's Chain Entry is Slot 99 (`core/flush/chain-entry.json`):

- **Chain:** `ecash:betanet-s99`. The identity block is the explorer's genesis, `04dfb01b…`.
- **`activation`:** eCash block 968,998. It is the last of 1,009 consecutive M2 ACKs for the Photon M1 in block 967,989, as with Elements' activation (ADR 0004). The first M5 to Slot 99 is in block 973,928. With the pin, `flush.wasm` declares `depositDestination`, and Deposits to Slot 99 are written `s99_<address>_<checksum>`.
- **Everything else stays:** the module, its address parameters, `depositConfirmations`, the Server API (ADR 0012) and token reading (ADR 0013) were all researched on the Slot 99 chain.

## Considered options

- **Keep Slot 46 and wait:** rejected. Slot 46 won't exist on betanet, so Flush would stay unusable there.
- **A test build pointed at Slot 99, off the main line:** rejected. Slot 99 is what betanet's Flush is, not a stand-in for it.
- **A slot per network in the Chain Entry envelope:** deferred to mainnet (#32). Today betanet is the only network, so the entry's one `slot` is Slot 99.

## Consequences

- Flush's Starter is derived for Slot 99, as are its addresses. The wallet keeps asset names, Deposits and grants by Slot, so Slot 99 shares no data with a later Slot 46.
- When mainnet (#32) adds Flush, its network needs Slot 46, which the envelope cannot express per network today. Slot 99 must never be bundled for mainnet.
- If Flush's developer drops or restarts the Slot 99 chain on betanet, its identity check fails until the entry is updated. Coins on it are test coins, as the node itself warns.
