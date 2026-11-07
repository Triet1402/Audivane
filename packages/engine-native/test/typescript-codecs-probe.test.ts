import assert from "node:assert/strict";
import test from "node:test";
import { probeNativeCodecCapabilities } from "../src/typescript/capabilities.js";
import type { NativeProcessRunOptions, NativeProcessResult } from "../src/typescript/process.js";

test("failed or timed-out capability listings never claim the implementation is missing", async () => {
  const runner = { async run(options: NativeProcessRunOptions): Promise<NativeProcessResult> {
    if (options.args.includes("-encoders")) throw new Error("FFmpeg encoder probe exceeded its 20000 ms time limit");
    if (options.args.includes("-decoders")) return { code: 2, signal: null, stdout: "", stderr: "failed" };
    return { code: 0, signal: null, stdout: "version fixture\n", stderr: "" };
  } };
  const observed = await probeNativeCodecCapabilities(runner, {
    repositoryRoot: "/private", ffmpegPath: "/private/ffmpeg", ffprobePath: "/private/ffprobe",
    ldacHelperPath: null, ffmpegReason: null, ffprobeReason: null, ldacHelperReason: "not found",
  });
  const opus = observed.codecs.find(codec => codec.codecId === "opus")!;
  assert.equal(opus.availability, "unavailable");
  assert.match(opus.reason!, /FFmpeg encoder probe timed out/);
  assert.match(opus.reason!, /FFmpeg decoder probe failed \(exit 2\)/);
  assert.doesNotMatch(opus.reason!, /encoder libopus is missing|decoder opus is missing|\/private/);
  assert.ok(observed.limitations.some(note => note.includes("encoder probe timed out")));
});
