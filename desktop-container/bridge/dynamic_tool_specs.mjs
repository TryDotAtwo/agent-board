import { historyTools } from "./history_mcp.mjs";
import { telegramBoardTools } from "./telegram_board_service.mjs";

const artifactTools = [
  {
    name: "create_artifact",
    description: "Create a Telegram response artifact for the current Codex turn.",
    inputSchema: { type: "object", properties: {
      relative_path: { type: "string", minLength: 1 }, content: { type: "string" },
      encoding: { enum: ["utf8", "base64"] }, caption: { type: "string", maxLength: 1024 },
    }, required: ["relative_path", "content"] },
  },
  {
    name: "publish_artifact",
    description: "Publish a Playwright screenshot or existing outbox file for the current Codex turn.",
    inputSchema: { type: "object", properties: {
      source_path: { type: "string", minLength: 1 }, output_name: { type: "string", minLength: 1 },
      caption: { type: "string", maxLength: 1024 },
    }, required: ["source_path", "output_name"] },
  },
  {
    name: "list_turn_artifacts",
    description: "List artifacts registered for the current Codex turn.",
    inputSchema: { type: "object", properties: {} },
  },
];

const snapshotProperties = {
  mode: { enum: ["working_tree", "git_commit"] },
  paths: { type: "array", maxItems: 512, items: { type: "string", minLength: 1, maxLength: 512 } },
  commit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
};
const leanTools = [
  { name: "lean_check", description: "Check selected Lean source files in the isolated worker. Success is lean_checked, not independently verified.",
    inputSchema: { type: "object", properties: { ...snapshotProperties, targets: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 512 } }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, required: ["mode", "targets"] } },
  { name: "lean_goal_state", description: "Return Lean goals and local context at a source position from the isolated worker.",
    inputSchema: { type: "object", properties: { ...snapshotProperties, path: { type: "string", minLength: 1, maxLength: 512 }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } }, required: ["mode", "path", "line", "column"] } },
  { name: "lean_search_mathlib", description: "Search the exactly pinned Mathlib declaration index. Use for relevant formalization work, not as a general web search.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 256 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } },
  { name: "lean_build", description: "Build named Lake targets in an isolated worker snapshot.",
    inputSchema: { type: "object", properties: { ...snapshotProperties, targets: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" } }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, required: ["mode", "targets"] } },
  { name: "lean_validate", description: "Independently validate an immutable working-tree or exact-commit snapshot and produce a content-hashed receipt. Only this tool may return verified.",
    inputSchema: { type: "object", properties: { ...snapshotProperties, targets: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", maxLength: 512 } }, theorems: { type: "array", maxItems: 128, items: { type: "string", maxLength: 512 } }, statement_locks: { type: "object", additionalProperties: { type: "string", pattern: "^[0-9a-f]{64}$" } } }, required: ["mode", "targets"] } },
];

const namespace = (name, description, tools) => ({
  type: "namespace", name, description,
  tools: tools.map(({ name: toolName, description: toolDescription, inputSchema }) => ({
    type: "function", name: toolName, description: toolDescription, inputSchema,
  })),
});

const vmTools = [
  { name: "exec", description: "Run a shell command on the fixed VM (4 vCPU, 30 GiB RAM, Tesla P4 8 GiB). Returns stdout, stderr, exit status and timeout. Timeout disconnects SSH; a remote job may continue. For long tasks launch a remote job with logs, then inspect it using another command.",
    inputSchema: { type: "object", additionalProperties: false, properties: { command: { type: "string", minLength: 1, maxLength: 65536 }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 } }, required: ["command"] } },
  { name: "upload", description: "Write a file on the fixed VM, up to 8 MiB. Returns exact byte count and SHA256; existing destination is overwritten. No agent runs inside this tool.",
    inputSchema: { type: "object", additionalProperties: false, properties: { remote_path: { type: "string", minLength: 1, maxLength: 4096 }, content: { type: "string" }, encoding: { enum: ["utf8", "base64"] } }, required: ["remote_path", "content"] } },
  { name: "download", description: "Download a file up to 8 MiB from the fixed VM, verify its content hash, and attach it to the current Telegram answer.",
    inputSchema: { type: "object", additionalProperties: false, properties: { remote_path: { type: "string", minLength: 1, maxLength: 4096 }, output_name: { type: "string", minLength: 1 }, caption: { type: "string", maxLength: 1024 } }, required: ["remote_path", "output_name"] } },
];

export function dynamicToolSpecs({ browserTools = [], toolNamespaces = [], board = false, includeHistory = true } = {}) {
  const specs = [
    ...(includeHistory ? [namespace("windows_codex_history", "Read original Windows Codex tasks for this thread's fixed project.", historyTools)] : []),
    namespace("telegram_outbox", "Create and publish artifacts for the current Telegram response.", artifactTools),
  ];
  if (board) specs.push(namespace("telegram_board", "Read and contribute to the shared Telegram board as this expert. Peers are independent agents, not an authority or a requirement to reply.", telegramBoardTools));
  if (browserTools.length) specs.push(namespace("playwright", "Control this expert's isolated browser.", browserTools));
  if (toolNamespaces.includes("lean")) specs.push(namespace("lean", "Use isolated pinned Lean worker and independent validator services.", leanTools));
  if (toolNamespaces.includes("vm")) specs.push(namespace("vm", "Execute commands and transfer files on the fixed remote VM via isolated SSH. No host, credentials or other agent selectors.", vmTools));
  return specs;
}
