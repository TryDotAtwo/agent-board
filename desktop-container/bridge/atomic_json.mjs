import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640, 1000, 1000];

// One writer per state file. Capture mutable caller state at invocation time,
// then publish in invocation order without poisoning later saves on failure.
export function orderedJsonWriter(file) {
  let chain = Promise.resolve();
  return async value => {
    const snapshot = JSON.parse(JSON.stringify(value));
    const result = chain.then(() => atomicJson(file, snapshot));
    chain = result.catch(() => {});
    return result;
  };
}

// Sync the replacement before publishing it. Never remove the current target
// to make rename work: readers must see either the old or the new valid JSON.
export async function atomicJson(file, value, { renameFile = rename, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  if (typeof renameFile !== "function" || !Array.isArray(retryDelaysMs) || retryDelaysMs.length > 8
    || retryDelaysMs.some((ms) => !Number.isSafeInteger(ms) || ms < 0 || ms > 1000)) throw new Error("invalid atomic rename retry options");
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    // A Docker bind reader can temporarily open the Windows target without
    // delete sharing. Retry only publishing this already-synced file, never
    // its caller or any external operation such as sending a Chat message.
    for (let attempt = 0; ; attempt++) {
      try { await renameFile(temporary, file); break; }
      catch (error) {
        if (!SHARING_ERRORS.has(error.code) || attempt >= retryDelaysMs.length) throw error;
        await delay(retryDelaysMs[attempt]);
      }
    }
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
