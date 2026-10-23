# The address `getAddresses` gives out needs no `bip32_derivation`

A Sidechain App that builds a PSET spending the user's coins knows only what `getAddresses` gave it: an address. Rule 7 of the Signing Request asked every input to carry `bip32_derivation`, the fingerprint and path of the key it needs, and `sign` signs only an input whose entry re-derives to the Starter. So an app could not build a PSET the wallet would sign without first learning the Starter's fingerprint. The DEX's asset issuance (#45) is the first app to hit this: its PSET spends one coin at the `getAddresses` address and pays the asset, the reissuance token and the change back to the same address.

The wallet now proves those inputs and outputs are its own from the script alone:

- **An input with no `bip32_derivation`** is the wallet's when its `witness_utxo` script is the p2wpkh of a receive address `getAddresses` gives out. Today that is only `m/84'/1'/0'/0/0`. The count is `APP_RECEIVE_ADDRESSES`, in the Elements module and in `wallet/src/accounts.ts`, and the two must match. Any other key of the wallet's must still be named by an entry. An input that has no entry and isn't the wallet's is refused (`missingInputFields`).
- **An output with no `bip32_derivation`** paying that address is the wallet's too, so Blind Signing's verifiable facts and the Clear View count it as coming back.
- **`sign`** gives LWK the entry the wallet worked out, on the copy it signs. The PSET it returns differs from the request by signatures only.
- **`check` keeps only half of rule 7.** It runs before unlock and has no Starter, so it can't recognise the address. It requires `witness_utxo`, and `decode` and `sign` apply the rest. A PSET whose foreign input has no entry is now refused after the user unlocks, not before.
- **A PSET with no input of the wallet's is refused** (`nothingToSign`), by `decode` and `sign`. Before, `sign` returned it unsigned and the app found out only at broadcast.
- **`getAddresses` also returns `publicKey`:** the 33-byte compressed key the address pays, in hex, to any app with a `getAddresses` Grant. The DEX writes it into an asset contract's `issuer_pubkey`. It reveals nothing new: the key is on-chain once the address is spent, and it names only that address. Apps should treat an entry without `publicKey` as coming from an older wallet.

## Considered Options

- **`getAddresses` returns the key origin (`fingerprint`, `path`), and the app writes the entry:** rejected. The fingerprint is the same for every address of a Slot's Starter, so it would be a stable identifier any app could collect and compare across origins. Limiting it to apps with a `signTransaction` Grant narrows who learns it but doesn't make it less permanent.
- **Recognise every receive and change address up to the gap limit:** rejected. An app could then put the wallet's change coins from a Send into its PSET, with the user's approval as the only guard. Recognising only the given-out address keeps an app to the coins at the address it was given. Recognising one address also needs no derivation scan.
- **Cache the given-out address's script so `check` can apply all of rule 7 while locked:** rejected. It adds stored state to save an unlock on a malformed request.

## Consequences

- A DEX-built PSET with no entries can be signed only by this wallet. A standard signer (a hardware wallet, another software wallet) finds its keys through `bip32_derivation` and would skip the input. An app that supports other wallets gets the key origin from them.
- If `getAddresses` gives out more addresses, `APP_RECEIVE_ADDRESSES` grows in both places, and those addresses can be spent without entries too.
- L1's `sign` is unchanged (its addresses gain `publicKey` only): it may still return a PSBT with nothing signed (#40).
