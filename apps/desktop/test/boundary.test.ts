import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { APP_URL, OPERATIONS, allowedDocument, allowedResource, allowedDownload, assetPath, correlationId, validateRequest } from "../src/boundary.js";
const id = "0123456789abcdef0123456789abcdef";
const request = { version: 1, sampleRateMode: "native", preparationPolicy: "aligned-gain-matched-v1", a: { codecId: "noop_passthrough", bitrateKbps: 0 }, b: { codecId: "opus", bitrateKbps: 96 } };
const envelope = (args: unknown[]) => ({ version: 1, id, args });
test("fixed operations reject unknown keys, argument counts, handles, enums and executable/path configuration", () => {
  const malformed = envelope(["/etc/passwd", {}, id]);
  assert.equal(correlationId(malformed), id, "validation failures retain the bounded caller ID");
  assert.throws(() => validateRequest("prepare", malformed));
  assert.throws(() => correlationId({ id: "/etc/passwd" }));
  for (const operation of OPERATIONS) {
    assert.throws(() => validateRequest(operation, { ...envelope([]), channel: "shell" }));
    assert.throws(() => validateRequest(operation, envelope([1, 2, 3, 4])));
  }
  for (const args of [["/tmp/source.wav", request, id], [id, { ...request, repositoryRoot: "/tmp" }, id], [id, { ...request, a: { ...request.a, path: "/tmp" } }, id], [id, { ...request, preparationPolicy: "unknown-policy-v0" }, id], [id, { ...request, preparationPolicy: "codec-probe-only" }, id]]) assert.throws(() => validateRequest("prepare", envelope(args)));
  assert.deepEqual(validateRequest("prepare", envelope([id, request, id])).args, [id, request, id]);
  for (const [operation, args] of [["answer", [id, "a"]], ["trialAudio", [id, "sourceA"]], ["readAudio", [id, "X"]], ["readCanaryAudio", [id, "a"]], ["seal", ["\nsecret"]]] as const) assert.throws(() => validateRequest(operation, envelope([...args])));
  assert.throws(() => validateRequest("configure", envelope([{ version: 1, alpha: 0.05, plannedTrials: 4, labelMode: "fixed", calibrationEnabled: false, secret: "renderer" }])));
});
test("document/resource and download allowlists deny remote/file/data/arbitrary Blob URLs", () => {
  assert.equal(allowedDocument(APP_URL), true);
  for (const url of ["https://app/index.html", "file:///tmp/index.html", "codec-abx://app/other.html", APP_URL + "#fragment", APP_URL + "?remote=1"]) assert.equal(allowedDocument(url), false);
  assert.equal(allowedResource("codec-abx://app/assets/client.js"), true);
  for (const url of ["https://example.com", "file:///etc/passwd", "data:text/html,test", "codec-abx://app:99/index.html", "codec-abx://user@app/index.html"]) assert.equal(allowedResource(url), false);
  const blob = "blob:codec-abx://app/01234567-0123-4123-8123-0123456789ab";
  assert.equal(allowedDownload(blob, "application/json", [blob]), true);
  for (const [url, mime, chain] of [["file:///etc/passwd", "application/json", ["file:///etc/passwd"]], [blob, "text/html", [blob]], [blob, "application/json", ["https://example.com", blob]], ["blob:https://example.com/id", "audio/wav", ["blob:https://example.com/id"]]] as const) assert.equal(allowedDownload(url, mime, chain), false);
});
test("asset resolution rejects escaped realpaths and symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-assets-"));
  try {
    await fs.mkdir(path.join(root, "assets")); await fs.writeFile(path.join(root, "assets/ok.js"), "ok");
    await fs.symlink("/etc/passwd", path.join(root, "assets/escape"));
    assert.equal(await assetPath(root, "codec-abx://app/assets/ok.js"), path.join(root, "assets/ok.js"));
    for (const url of ["codec-abx://app/assets/escape", "codec-abx://app/%2e%2e%2fetc/passwd", "codec-abx://app/%5cetc%5cpasswd", "file:///etc/passwd", "codec-abx://app/assets/%00ok.js"]) await assert.rejects(assetPath(root, url));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
