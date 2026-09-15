import net from "node:net";
import { randomUUID } from "node:crypto";

const WORKER_TOOLS = new Set(["lean_check", "lean_goal_state", "lean_search_mathlib", "lean_build"]);

export class LeanToolClient {
  constructor({ workerSocket, validatorSocket, timeoutMs = 310000, maxResponseBytes = 2 * 1024 * 1024 }) {
    Object.assign(this, { workerSocket, validatorSocket, timeoutMs, maxResponseBytes });
  }

  call(toolName, args = {}) {
    const service = toolName === "lean_validate" ? "validator" : WORKER_TOOLS.has(toolName) ? "worker" : undefined;
    if (!service) return Promise.reject(new Error(`unknown Lean tool: ${toolName}`));
    const operation = toolName.slice(5);
    const request = { version: 1, request_id: randomUUID(), service, operation, params: args };
    const socketPath = service === "worker" ? this.workerSocket : this.validatorSocket;
    return new Promise((resolve, reject) => {
      let bytes = 0;
      let buffer = "";
      const socket = net.createConnection({ path: socketPath });
      const timer = setTimeout(() => socket.destroy(new Error(`${service} request timed out`)), this.timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.maxResponseBytes) socket.destroy(new Error("Lean service response is too large"));
        else buffer += chunk;
      });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("close", (hadError) => {
        clearTimeout(timer);
        if (hadError) return;
        try {
          const response = JSON.parse(buffer.trim());
          if (response.request_id !== request.request_id) throw new Error("Lean service request id mismatch");
          resolve(response);
        } catch (error) { reject(error); }
      });
    });
  }
}
