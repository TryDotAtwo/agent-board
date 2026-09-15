import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopMcpClient } from "./desktop_mcp_client.mjs";
import { ProGateway } from "./pro_gateway.mjs";

function required(env, name) {
  if (typeof env[name] !== "string" || !env[name].trim()) {
    throw Object.assign(new Error(`${name} is required; use the genuine inherited Desktop executor environment`), { code: "GATEWAY_ENV_REQUIRED" });
  }
  return env[name];
}

export async function runProGateway({ env = process.env, signal, log = console.log } = {}) {
  const root = required(env, "PRO_GATEWAY_ROOT");
  const threadId = required(env, "PRO_CHAT_THREAD_ID");
  const serverPath = required(env, "PRO_DESKTOP_MCP_SERVER");
  const sourceThreadId = required(env, "CODEX_THREAD_ID");
  required(env, "CODEX_APP_TOOLS_PIPE_PATH");
  if (!path.isAbsolute(serverPath)) throw Object.assign(new Error("PRO_DESKTOP_MCP_SERVER must be an absolute stock server path"), { code: "GATEWAY_ENV_INVALID" });
  // The MCP child inherits process.env unchanged. No caller/pipe discovery,
  // cookie extraction, model override, browser control or HTTP endpoint exists.
  const gateway = new ProGateway({ root, threadId,
    clientFactory: () => new DesktopMcpClient({ serverPath, sourceThreadId, targetThreadId: threadId }),
  });
  const abort = () => { void gateway.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let ready = false;
  let previousState;
  try {
    while (!signal?.aborted) {
      const result = await gateway.tick();
      if (!ready) { ready = true; log(JSON.stringify({ event: "pro_gateway_ready", pid: process.pid })); }
      const state = result ? `${result.id}:${result.status}:${result.error || ""}` : "idle";
      if (state !== previousState) {
        previousState = state;
        log(JSON.stringify({ event: "pro_gateway_status", id: result?.id, status: result?.status || "idle", error: result?.error }));
      }
      if (!signal?.aborted) await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal?.aborted || (error.name !== "AbortError" && error.code !== "GATEWAY_CLOSED")) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await gateway.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await runProGateway({ signal: controller.signal }); }
  catch (error) {
    // Never print private Desktop diagnostics, prompts, answers or env values.
    const known = new Set(["GATEWAY_ENV_REQUIRED", "GATEWAY_ENV_INVALID", "GATEWAY_LOCKED", "INVALID_ROOT",
      "INVALID_TARGET", "INVALID_LEDGER", "REQUEST_CONFLICT", "MULTIPLE_ACTIVE", "LOCK_OWNERSHIP_CHANGED"]);
    console.error(JSON.stringify({ event: "pro_gateway_fatal", code: known.has(error.code) ? error.code : "GATEWAY_FAILED" }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
