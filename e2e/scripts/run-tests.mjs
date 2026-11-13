// `node scripts/run-tests.mjs <node --test args>...`: run the e2e tests once no other e2e run on this
// machine is running. The e2e build bakes fixed stub ports into its Chain Entries (`E2E_L1_SERVER`
// and the others in build.mjs), so two runs at once, from any checkout or worktree, take each
// other's stubs and fail in confusing ways. Each run waits for the one before it instead.
//
// The lock is a listening socket on LOCK_PORT: the OS frees it when this process exits, however it
// exits, so a killed run never leaves a stale lock behind.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const LOCK_PORT = 24099;
const RETRY_MS = 2_000;

function tryLock() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)));
    server.listen(LOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

let lock = await tryLock();
if (lock === undefined) {
  console.error(`Another e2e run holds 127.0.0.1:${LOCK_PORT}; waiting for it to finish…`);
  while (lock === undefined) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    lock = await tryLock();
  }
}
// Held, but never keeps the process alive on its own.
lock.unref();

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
