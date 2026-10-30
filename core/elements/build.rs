// Picks the Chain Entry the module embeds: `chain-entry.json`, or the file named by
// `$ECX_ELEMENTS_CHAIN_ENTRY` (the e2e build's, from e2e/scripts/build.mjs).
use std::env;
use std::path::PathBuf;

fn main() {
    // The network the module serves: `$ECX_NETWORK`, betanet when unset (as for `cargo test`). The
    // shipped build sets mainnet, the e2e build betanet (core/scripts/build.mjs).
    println!("cargo:rerun-if-env-changed=ECX_NETWORK");
    let network = env::var("ECX_NETWORK").unwrap_or_else(|_| "betanet".into());
    println!("cargo:rustc-env=ECX_NETWORK={network}");
    println!("cargo:rerun-if-env-changed=ECX_ELEMENTS_CHAIN_ENTRY");
    let path = match env::var_os("ECX_ELEMENTS_CHAIN_ENTRY") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("chain-entry.json"),
    };
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-env=ECX_ELEMENTS_CHAIN_ENTRY_PATH={}", path.display());
}
