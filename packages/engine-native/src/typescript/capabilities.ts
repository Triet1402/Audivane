import { CODEC_IDS, type CodecId } from "@codec-abx/contracts";

import type { NativeBinaryResolution } from "./binaries.js";
import { nativeCodecPlan } from "./catalog.js";
import {
  NativeProcessCleanupError,
  type NativeProcessManager,
  type NativeProcessResult,
} from "./process.js";

export interface NativeCodecCapability {
  readonly codecId: CodecId;
  readonly availability: "available" | "unavailable";
  readonly encoder: string;
  readonly decoder: string;
  readonly reason: string | null;
}

export interface NativeCodecCapabilities {
  readonly schema: "native-codec-capabilities-v1";
  readonly ffmpegVersion: string | null;
  readonly ffprobeVersion: string | null;
  readonly ldacHelperVersion: string | null;
  readonly tools: Readonly<{
    readonly ffmpeg: boolean;
    readonly ffprobe: boolean;
    readonly ldacHelper: boolean;
  }>;
  readonly codecs: readonly NativeCodecCapability[];
  readonly limitations: readonly string[];
}

const CAPABILITY_TIMEOUT_MS = 20_000;
const CAPABILITY_OUTPUT_BYTES = 1024 * 1024;

export async function probeNativeCodecCapabilities(
  runner: Pick<NativeProcessManager, "run">,
  resolution: NativeBinaryResolution,
  signal?: AbortSignal,
): Promise<NativeCodecCapabilities> {
  const probeFailures = new Map<string, string>();
  const run = async (
    file: string | null,
    args: readonly string[],
    label: string,
  ): Promise<NativeProcessResult | null> => {
    if (file === null) { probeFailures.set(label, `${label} unavailable: executable not resolved`); return null; }
    try {
      const result = await runner.run({
        file,
        args,
        label,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: CAPABILITY_TIMEOUT_MS,
        maxStdoutBytes: CAPABILITY_OUTPUT_BYTES,
        maxStderrBytes: CAPABILITY_OUTPUT_BYTES,
      });
      if (result.code !== 0) probeFailures.set(label, `${label} failed (exit ${String(result.code)})`);
      return result;
    } catch (error: unknown) {
      if (error instanceof NativeProcessCleanupError ||
          (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
      const timeout = error instanceof Error && /time limit|timed out/i.test(error.message);
      probeFailures.set(label, `${label} ${timeout ? "timed out" : "failed"}`);
      return null;
    }
  };

  const results = await Promise.allSettled([
      run(resolution.ffmpegPath, ["-hide_banner", "-version"], "FFmpeg version probe"),
      run(resolution.ffprobePath, ["-hide_banner", "-version"], "ffprobe version probe"),
      run(resolution.ffmpegPath, ["-hide_banner", "-encoders"], "FFmpeg encoder probe"),
      run(resolution.ffmpegPath, ["-hide_banner", "-decoders"], "FFmpeg decoder probe"),
      run(resolution.ffmpegPath, ["-hide_banner", "-muxers"], "FFmpeg muxer probe"),
      run(resolution.ffmpegPath, ["-hide_banner", "-demuxers"], "FFmpeg demuxer probe"),
      run(resolution.ldacHelperPath, ["--version"], "LDAC helper version probe"),
    ]);
  // A probe is one owned operation: wait for every cancelled subprocess before
  // rejecting, even when the first child has already exited with AbortError.
  const failure = results.find(result => result.status === "rejected" &&
    result.reason instanceof NativeProcessCleanupError) ??
    results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const resultAt = (index: number): NativeProcessResult | null => {
    const result = results[index];
    return result?.status === "fulfilled" ? result.value : null;
  };
  const [ffmpegVersion, ffprobeVersion, encoders, decoders, muxers, demuxers, helperVersion] =
    [resultAt(0), resultAt(1), resultAt(2), resultAt(3), resultAt(4), resultAt(5), resultAt(6)] as const;

  const versionOf = (result: NativeProcessResult | null): string | null => {
    if (!result || result.code !== 0) return null;
    const line = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    return line ?? null;
  };
  const helperVersionOf = (result: NativeProcessResult | null): string | null => {
    if (!result || result.code !== 0) return null;
    const lines = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    return lines.length > 0 ? lines.join(" | ") : null;
  };
  const namesOf = (result: NativeProcessResult | null, splitAliases: boolean): Set<string> => {
    const names = new Set<string>();
    if (!result || result.code !== 0) return names;
    for (const raw of result.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      const match = /^[A-Z.]{1,6}\s+(\S+)/.exec(line);
      if (!match) continue;
      const name = match[1];
      if (!name || name.endsWith(":")) continue;
      if (splitAliases) {
        for (const alias of name.split(",")) if (alias) names.add(alias);
      } else {
        names.add(name);
      }
    }
    return names;
  };

  const ffmpegVersionText = versionOf(ffmpegVersion);
  const ffprobeVersionText = versionOf(ffprobeVersion);
  const ldacHelperVersionText = helperVersionOf(helperVersion);
  const encoderNames = namesOf(encoders, false);
  const decoderNames = namesOf(decoders, false);
  const muxerNames = namesOf(muxers, true);
  const demuxerNames = namesOf(demuxers, true);

  const toolsReady = resolution.ffmpegPath !== null && resolution.ffprobePath !== null &&
    ffmpegVersionText !== null && ffprobeVersionText !== null;

  const codecs: NativeCodecCapability[] = CODEC_IDS.map((codecId) => {
    const plan = nativeCodecPlan(codecId);
    if (plan.kind === "noop") {
      return Object.freeze({
        codecId,
        availability: toolsReady ? "available" : "unavailable",
        encoder: plan.encoder,
        decoder: plan.decoder,
        reason: toolsReady ? null : "FFmpeg/ffprobe source decode toolchain is unavailable",
      });
    }
    if (plan.kind === "ldac-helper") {
      const ready = toolsReady && resolution.ldacHelperPath !== null &&
        ldacHelperVersionText !== null;
      const reason = ready
        ? null
        : resolution.ldacHelperPath === null
          ? `LDAC helper unavailable: ${resolution.ldacHelperReason ?? "not found"}`
          : ldacHelperVersionText === null
            ? probeFailures.get("LDAC helper version probe") ?? "LDAC helper version probe failed"
            : "FFmpeg/ffprobe toolchain is unavailable";
      return Object.freeze({
        codecId,
        availability: ready ? "available" : "unavailable",
        encoder: plan.encoder,
        decoder: plan.decoder,
        reason,
      });
    }

    const missing: string[] = [];
    if (!toolsReady) missing.push("FFmpeg/ffprobe source decode toolchain is unavailable");
    if (probeFailures.has("FFmpeg encoder probe")) missing.push(probeFailures.get("FFmpeg encoder probe")!);
    else if (!encoderNames.has(plan.encoder)) missing.push(`encoder ${plan.encoder} is missing`);
    if (probeFailures.has("FFmpeg decoder probe")) missing.push(probeFailures.get("FFmpeg decoder probe")!);
    else if (!decoderNames.has(plan.decoder)) missing.push(`decoder ${plan.decoder} is missing`);
    if (probeFailures.has("FFmpeg muxer probe")) missing.push(probeFailures.get("FFmpeg muxer probe")!);
    else if (plan.muxer !== null && !muxerNames.has(plan.muxer)) {
      missing.push(`muxer ${plan.muxer} is missing`);
    }
    if (probeFailures.has("FFmpeg demuxer probe")) missing.push(probeFailures.get("FFmpeg demuxer probe")!);
    else if (plan.demuxer !== null && !demuxerNames.has(plan.demuxer)) {
      missing.push(`demuxer ${plan.demuxer} is missing`);
    }
    return Object.freeze({
      codecId,
      availability: missing.length === 0 ? "available" : "unavailable",
      encoder: plan.encoder,
      decoder: plan.decoder,
      reason: missing.length === 0 ? null : missing.join("; "),
    });
  });

  return Object.freeze({
    schema: "native-codec-capabilities-v1",
    ffmpegVersion: ffmpegVersionText,
    ffprobeVersion: ffprobeVersionText,
    ldacHelperVersion: ldacHelperVersionText,
    tools: Object.freeze({
      ffmpeg: toolsReady,
      ffprobe: resolution.ffprobePath !== null && ffprobeVersionText !== null,
      ldacHelper: resolution.ldacHelperPath !== null && ldacHelperVersionText !== null,
    }),
    codecs: Object.freeze(codecs),
    limitations: Object.freeze([
      ...new Set(probeFailures.values()),
      "Capabilities are established only by probing the resolved FFmpeg/ffprobe encoders, " +
        "decoders, muxers, demuxers and (for LDAC) the external helper.",
      "MP2 requires the real libtwolame encoder; the built-in FFmpeg mp2 encoder is not a substitute.",
      "LC3 is encoded at an explicit 48 kHz / 10 ms internal configuration and decoded back to the session rate.",
      "No external interpreter, module, bridge or fallback is used or required.",
    ]),
  });
}
