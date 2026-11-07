import { CODEC_IDS, type CodecId } from "@codec-abx/contracts";

import type { NativeBinaryResolution } from "./binaries.js";
import type {
  NativeCodecCapabilities,
  NativeCodecCapability,
} from "./capabilities.js";

/**
 * Readiness describes one concrete machine/bundle after actual capability
 * probing. A resolved executable path alone is never reported as codec
 * support.
 */
export interface NativeReadinessTool {
  readonly required: boolean;
  readonly available: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly reason: string | null;
}

export interface NativeReadinessCodec {
  readonly codecId: CodecId;
  readonly required: boolean;
  readonly availability: NativeCodecCapability["availability"];
  readonly reason: string | null;
}

export interface NativeReadinessReport {
  readonly schema: "native-readiness-v1";
  readonly ok: boolean;
  readonly platform: Readonly<{
    readonly platform: string;
    readonly arch: string;
    readonly supported: boolean;
  }>;
  readonly tools: Readonly<{
    readonly ffmpeg: NativeReadinessTool;
    readonly ffprobe: NativeReadinessTool;
    readonly ldacHelper: NativeReadinessTool;
  }>;
  readonly codecs: readonly NativeReadinessCodec[];
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly remediation: readonly string[];
}

const REQUIRED_CODECS: ReadonlySet<CodecId> = new Set(
  CODEC_IDS.filter((codecId) => codecId !== "ldac"),
);

function tool(
  required: boolean,
  path: string | null,
  version: string | null,
  resolutionReason: string | null,
  label: string,
): NativeReadinessTool {
  const reason = path === null
    ? resolutionReason ?? `${label} was not found`
    : version === null
      ? `${label} was found at ${path} but did not report a usable version`
      : null;
  return Object.freeze({
    required,
    available: path !== null && version !== null,
    path,
    version,
    reason,
  });
}

function remediationFor(
  ffmpeg: NativeReadinessTool,
  ffprobe: NativeReadinessTool,
  ldacHelper: NativeReadinessTool,
  missingCodecs: readonly NativeReadinessCodec[],
  platform: string,
): string[] {
  const steps: string[] = [];
  const windows = platform === "win32";
  const ffmpegBuild = windows
    ? "tools/build_ffmpeg_windows.sh in an MSYS2 MINGW64/UCRT64/CLANG64 shell"
    : "tools/build_ffmpeg.sh";
  const ldacBuild = windows
    ? "tools/build_ldac_helper_windows.sh"
    : "tools/build_ldac_helper.sh";
  const helperName = windows ? "ldac_helper.exe" : "ldac_helper";
  const binaryDirectory = windows
    ? "third_party/ffmpeg/bin (ffmpeg.exe/ffprobe.exe)"
    : "third_party/ffmpeg/bin";
  if (!ffmpeg.available || !ffprobe.available) {
    steps.push(
      "Install FFmpeg and ffprobe, or build the pinned native tools with " +
        `${ffmpegBuild}, then use ${binaryDirectory}, an explicit ` +
        "prepared bundle (--native-bundle <dir>), or absolute CODEC_ABX_FFMPEG " +
        "and CODEC_ABX_FFPROBE paths.",
    );
  }
  if (missingCodecs.length > 0) {
    steps.push(
      `Use the pinned FFmpeg build from ${ffmpegBuild} (liblc3, libtwolame, ` +
        "libopus, libvorbis, libmp3lame) or another build that actually provides " +
        `the reported missing encoders/decoders/muxers/demuxers: ` +
        `${missingCodecs.map((codec) => codec.codecId).join(", ")}.`,
    );
  }
  if (!ldacHelper.available) {
    steps.push(
      `Optional LDAC only: build ${helperName} with ${ldacBuild} and ` +
        "set an absolute CODEC_ABX_LDAC_HELPER path (or place it under " +
        "third_party/ldac/bin). Without it all other codecs can still be ready.",
    );
  }
  return steps;
}

/**
 * Turn actual resolver plus capability-probe output into a bounded readiness
 * assessment. FFmpeg and ffprobe are required; LDAC is explicitly optional.
 */
export function assessNativeReadiness(
  resolution: NativeBinaryResolution,
  capabilities: NativeCodecCapabilities,
  platform: string = process.platform,
  arch: string = process.arch,
): NativeReadinessReport {
  const ffmpeg = tool(
    true,
    resolution.ffmpegPath,
    capabilities.ffmpegVersion,
    resolution.ffmpegReason,
    "FFmpeg",
  );
  const ffprobe = tool(
    true,
    resolution.ffprobePath,
    capabilities.ffprobeVersion,
    resolution.ffprobeReason,
    "ffprobe",
  );
  const ldacHelper = tool(
    false,
    resolution.ldacHelperPath,
    capabilities.ldacHelperVersion,
    resolution.ldacHelperReason,
    "LDAC helper",
  );
  const supported = (platform === "linux" || platform === "win32") && arch === "x64";
  const codecs: NativeReadinessCodec[] = capabilities.codecs.map((codec) => Object.freeze({
    codecId: codec.codecId,
    required: REQUIRED_CODECS.has(codec.codecId),
    availability: codec.availability,
    reason: codec.reason,
  }));
  const missingRequired = codecs.filter(
    (codec) => codec.required && codec.availability !== "available",
  );
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!supported) {
    problems.push(
      `This desktop distribution is validated for Linux x64 and Windows x64 only; ` +
        `current host is ${platform} ${arch}.`,
    );
  }
  if (!ffmpeg.available) problems.push(`FFmpeg is required: ${ffmpeg.reason ?? "unavailable"}.`);
  if (!ffprobe.available) problems.push(`ffprobe is required: ${ffprobe.reason ?? "unavailable"}.`);
  // When the core toolchain is absent, per-codec failure text adds no useful
  // information. Per-codec availability is still retained in `codecs`.
  if (ffmpeg.available && ffprobe.available) {
    for (const codec of missingRequired) {
      problems.push(
        `Required codec ${codec.codecId} is unavailable: ${codec.reason ?? "unsupported by this build"}.`,
      );
    }
  }
  if (!ldacHelper.available) {
    warnings.push(
      `LDAC is optional and unavailable: ${ldacHelper.reason ?? "helper not found"}.`,
    );
  }
  return Object.freeze({
    schema: "native-readiness-v1",
    ok: problems.length === 0,
    platform: Object.freeze({ platform, arch, supported }),
    tools: Object.freeze({ ffmpeg, ffprobe, ldacHelper }),
    codecs: Object.freeze(codecs),
    problems: Object.freeze(problems),
    warnings: Object.freeze(warnings),
    remediation: Object.freeze(remediationFor(ffmpeg, ffprobe, ldacHelper, missingRequired, platform)),
  });
}

function toolLine(label: string, value: NativeReadinessTool): string {
  const requirement = value.required ? "required" : "optional";
  const state = value.available ? "available" : "unavailable";
  const location = value.path === null ? "" : ` — ${value.path}`;
  const version = value.version === null ? "" : `\n    ${value.version}`;
  const reason = value.reason === null ? "" : `\n    reason: ${value.reason}`;
  return `  ${label} (${requirement}): ${state}${location}${version}${reason}`;
}

/** Stable human-readable form of the same report offered by `--json`. */
export function formatNativeReadiness(report: NativeReadinessReport): string {
  const lines = [
    `Native readiness: ${report.ok ? "READY" : "NOT READY"}`,
    `Platform: ${report.platform.platform} ${report.platform.arch} ` +
      `(${report.platform.supported ? "supported target" : "unsupported target"})`,
    "Tools:",
    toolLine("FFmpeg", report.tools.ffmpeg),
    toolLine("ffprobe", report.tools.ffprobe),
    toolLine("LDAC helper", report.tools.ldacHelper),
    "Codecs (actual capability probe, not file existence):",
  ];
  for (const codec of report.codecs) {
    const requirement = codec.required ? "required" : "optional";
    const reason = codec.reason === null ? "" : ` — ${codec.reason}`;
    lines.push(`  ${codec.codecId} (${requirement}): ${codec.availability}${reason}`);
  }
  if (report.problems.length > 0) {
    lines.push("Problems:");
    for (const problem of report.problems) lines.push(`  - ${problem}`);
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  if (report.remediation.length > 0) {
    lines.push("Remediation:");
    for (const step of report.remediation) lines.push(`  - ${step}`);
  }
  return lines.join("\n");
}
