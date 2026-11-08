import { CODEC_CATALOG, type CodecId } from "@codec-abx/contracts";

export function codecLabel(codecId: CodecId): string {
  if (codecId === "noop_passthrough") return "PCM16 passthrough (no-op)";
  if (codecId === "opus") return "Opus (libopus)";
  return CODEC_CATALOG[codecId].displayName;
}
