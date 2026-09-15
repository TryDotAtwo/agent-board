import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OutboxStore } from "./outbox_core.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "cayley-outbox-"));
const outboxRoot = path.join(root, "outbox");
const generatedRoot = path.join(root, "playwright");
await Promise.all([mkdir(outboxRoot), mkdir(generatedRoot)]);
const store = new OutboxStore({ outboxRoot, allowedSourceRoots: [generatedRoot, outboxRoot], maxBytes: 50 * 1024 * 1024 });

const notebook = await store.createArtifact({
  relativePath: "reports/result.ipynb",
  content: '{"nbformat":4,"cells":[]}',
  encoding: "utf8",
  turnId: "turn_1",
});
assert.equal((await readFile(notebook.path, "utf8")).includes('"nbformat":4'), true);
assert.equal(notebook.turnId, "turn_1");
assert.equal(notebook.mimeType, "application/x-ipynb+json");

const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
const image = await store.createArtifact({ relativePath: "images/plot.png", content: pngBytes.toString("base64"), encoding: "base64", turnId: "turn_1" });
assert.deepEqual(await readFile(image.path), pngBytes);

const firstSharedName = await store.createArtifact({ relativePath: "shared/result.txt", content: "first", turnId: "turn_a" });
const secondSharedName = await store.createArtifact({ relativePath: "shared/result.txt", content: "second", turnId: "turn_b" });
assert.notEqual(firstSharedName.path, secondSharedName.path);
assert.equal(await readFile(firstSharedName.path, "utf8"), "first");
assert.equal(await readFile(secondSharedName.path, "utf8"), "second");

await assert.rejects(() => store.createArtifact({ relativePath: "../escape.txt", content: "x", turnId: "turn_1" }), /relative|escape|traversal/i);
await assert.rejects(() => store.createArtifact({ relativePath: path.resolve(root, "absolute.txt"), content: "x", turnId: "turn_1" }), /relative/i);
await assert.rejects(() => store.createArtifact({ relativePath: "auth.json", content: "x", turnId: "turn_1" }), /secret/i);
await assert.rejects(() => store.createArtifact({ relativePath: "cookies.sqlite", content: "x", turnId: "turn_1" }), /secret/i);

const outsideDir = path.join(root, "outside");
await mkdir(outsideDir);
const turnOneRoot = path.join(outboxRoot, "turns", "turn_1");
await mkdir(turnOneRoot, { recursive: true });
await symlink(outsideDir, path.join(turnOneRoot, "linked-outside"), "junction");
await assert.rejects(() => store.createArtifact({ relativePath: "linked-outside/escape.txt", content: "x", turnId: "turn_1" }), /symlink|escape/i);

const source = path.join(generatedRoot, "analysis.md");
await writeFile(source, "analysis", "utf8");
const published = await store.publishArtifact({ sourcePath: source, outputName: "shared/analysis.md", turnId: "turn_2" });
assert.equal(await readFile(published.path, "utf8"), "analysis");
await assert.rejects(() => store.publishArtifact({ sourcePath: path.join(root, "outside.txt"), outputName: "outside.txt", turnId: "turn_2" }), /source root|ENOENT/i);

const huge = path.join(generatedRoot, "huge.bin");
await writeFile(huge, "x");
await truncate(huge, 50 * 1024 * 1024 + 1);
await assert.rejects(() => store.publishArtifact({ sourcePath: huge, outputName: "huge.bin", turnId: "turn_2" }), /50 MiB/);

const records = await store.listTurnArtifacts("turn_1");
await store.recordDelivery(notebook.artifactId, "delivered");
assert.equal((await store.listTurnArtifacts("turn_1")).find((item) => item.artifactId === notebook.artifactId).delivered, true);
assert.equal(records.length, 2);
assert.equal(new Set(records.map((item) => item.artifactId)).size, 2);
assert.ok((await stat(store.manifestPath)).isFile());
console.log("PASS outbox create, publish, manifest, traversal, secrets, roots, and size limits");
