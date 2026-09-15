import { createHash } from "node:crypto";

export class TurnBoundToolDispatcher {
  constructor({ history, outbox, browser, lean, vm, board, leanExpertId = "autolean", vmExpertId = "vm" }) {
    Object.assign(this, { history, outbox, browser, lean, vm, board, leanExpertId, vmExpertId });
  }

  async call({ expertId, turnId, namespace, tool, arguments: args = {} }) {
    if (namespace === "telegram_board") {
      if (!this.board) throw new Error("Telegram board tools are unavailable");
      return this.board.call({ expertId, tool, arguments: args });
    }
    if (namespace === "windows_codex_history") {
      return this.history.call({ expertId, tool, arguments: args });
    }
    if (namespace === "telegram_outbox" && tool === "create_artifact") {
      return this.outbox.createArtifact({
        relativePath: args.relative_path, content: args.content, encoding: args.encoding || "utf8",
        turnId, caption: args.caption,
      });
    }
    if (namespace === "telegram_outbox" && tool === "publish_artifact") {
      return this.outbox.publishArtifact({
        sourcePath: args.source_path, outputName: args.output_name, turnId, caption: args.caption,
      });
    }
    if (namespace === "telegram_outbox" && tool === "list_turn_artifacts") {
      return this.outbox.listTurnArtifacts(turnId);
    }
    if (namespace === "playwright") {
      if (!this.browser) throw new Error("isolated browser tools are unavailable");
      return this.browser.call(expertId, tool, args);
    }
    if (namespace === "lean") {
      if (expertId !== this.leanExpertId) throw new Error(`Lean tools are not authorized for expert ${expertId}`);
      if (!this.lean) throw new Error("Lean tools are unavailable");
      return this.lean.call(tool, args);
    }
    if (namespace === "vm") {
      if (expertId !== this.vmExpertId) throw new Error(`VM tools are not authorized for expert ${expertId}`);
      if (!this.vm) throw new Error("VM tools are unavailable");
      if (tool !== "download") return this.vm.call(tool, args);
      const { output_name, caption, ...remoteArgs } = args;
      if (!turnId || typeof output_name !== "string" || !output_name) throw new Error("VM download needs a current turn and output_name");
      const result = await this.vm.call(tool, remoteArgs);
      if (result.exit_code !== undefined && result.exit_code !== 0) return result;
      if (result.encoding !== "base64" || typeof result.content !== "string" || result.content.length > 12 * 1024 * 1024) throw new Error("VM download integrity error");
      const bytes = Buffer.from(result.content, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length > 8 * 1024 * 1024 || bytes.length !== result.bytes || sha256 !== result.sha256) throw new Error("VM download hash/integrity error");
      const artifact = await this.outbox.createArtifact({ relativePath: output_name, content: result.content,
        encoding: "base64", turnId, caption });
      return { bytes: bytes.length, sha256, artifact };
    }
    throw new Error(`unknown turn-bound tool: ${namespace || "none"}.${tool}`);
  }
}
