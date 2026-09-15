import http from "node:http";

const REQUEST_LIMIT = 12 * 1024 * 1024;
const RESPONSE_LIMIT = 13 * 1024 * 1024;
const TOOLS = new Set(["exec", "upload", "download"]);

export class VmToolClient {
  constructor({ socketPath, timeoutMs = 310000 } = {}) {
    if (typeof socketPath !== "string" || socketPath.length < 2 || /[\0\r\n]/.test(socketPath)
      || !(socketPath.startsWith("/") || (process.platform === "win32" && socketPath.startsWith("\\\\.\\pipe\\")))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 360000) throw new Error("Invalid VM client configuration");
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async call(tool, args = {}) {
    if (!TOOLS.has(tool)) throw new Error("Invalid VM tool");
    let body;
    try { body = JSON.stringify({ tool, arguments: args }); } catch { throw new Error("Invalid VM arguments"); }
    if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error("VM request is too large");
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const req = http.request({
        socketPath: this.socketPath, method: "POST", path: "/call", agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, res => {
        const chunks = [];
        let bytes = 0;
        res.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_LIMIT) { finish(new Error("VM response is too large")); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error("VM executor request failed");
            error.status = res.statusCode;
            try {
              const code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error?.code;
              if (typeof code === "string" && /^[a-z_]{1,40}$/.test(code)) error.code = code;
            } catch { /* Never echo untrusted error bodies. */ }
            finish(error);
            return;
          }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
            finish(null, value);
          } catch { finish(new Error("VM executor returned an invalid response")); }
        });
        res.on("error", () => finish(new Error("VM socket transport failed")));
        res.on("aborted", () => finish(new Error("VM socket transport failed")));
      });
      req.on("error", () => finish(new Error("VM socket transport failed")));
      timer = setTimeout(() => { finish(new Error("VM request timed out")); req.destroy(); }, this.timeoutMs);
      req.end(body);
    });
  }
}
