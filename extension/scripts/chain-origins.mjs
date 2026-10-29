import { readFile } from "node:fs/promises";

/** Every network's default Sidechain Server origin, across the bundled Chain Entries. */
export async function sidechainServerOrigins(files) {
  const origins = new Set();
  for (const file of files) {
    const entry = JSON.parse(await readFile(file, "utf8"));
    for (const network of Object.values(entry.networks)) origins.add(new URL(network.sidechainServer.url).origin);
  }
  return [...origins].sort();
}
