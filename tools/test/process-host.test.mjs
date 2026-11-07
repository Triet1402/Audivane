import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WINDOWS_PROCESS_HOST_FILENAME,
  resolveWindowsProcessHost,
  stageWindowsProcessHost,
} from "../verification/process-host.mjs";

test("Windows process host resolution is explicit and refuses relative overrides", () => {
  const root = path.join(os.tmpdir(), "audivane-process-host-root");
  assert.equal(
    resolveWindowsProcessHost(root, {}),
    path.join(root, "build", "windows-process-host", "bin", WINDOWS_PROCESS_HOST_FILENAME),
  );
  const explicit = path.join(os.tmpdir(), "trusted-host.exe");
  assert.equal(resolveWindowsProcessHost(root, { CODEC_ABX_PROCESS_HOST: explicit }), explicit);
  assert.throws(
    () => resolveWindowsProcessHost(root, { CODEC_ABX_PROCESS_HOST: "relative-host.exe" }),
    /absolute trusted executable path/,
  );
});

test("Windows process host staging fails closed for missing or non-PE inputs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "audivane-process-host-stage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    stageWindowsProcessHost(path.join(directory, "missing.exe"), directory),
    /process lifetime host is missing/,
  );
  await assert.rejects(
    stageWindowsProcessHost(process.execPath, directory),
    /not a Windows x64 PE32\+ executable/,
  );
});
