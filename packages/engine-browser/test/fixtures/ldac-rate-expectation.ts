// Independent byte/rate model for codec verification; never used by production.
const LDAC_HEADER_SIZE = 48;
const LDAC_FRAME_SAMPLES = 128;
const LDAC_RECORD_PREFIX_BYTES = 2;

/**
 * The documented measured-rate expectation for exactly one ldac_helper v1
 * container, mirroring the native executor's disclosed actual-rate basis
 * ("ldac-container-bytes-over-header-sample-duration": container bytes times 8
 * over the header's unpadded sample count divided by the header rate). The
 * container structure fixes the expected bytes for given inputs, so callers
 * gate measured provenance against this model instead of the requested stereo
 * number:
 *
 * - libldac quality modes differ from the requested stereo bitrate: mono uses
 *   the documented half-stereo rates 165/330/495 kbps for 330/660/990 at
 *   48 kHz, and 44.1 kHz stereo uses libldac's internal 303/606/909 (both
 *   documented in `tools/ldac_helper.c` and the native executor policy).
 * - One transport frame is ceil(base bytes per 128-sample frame) bytes long;
 *   libldac accounts its 3-byte frame header inside that budget. Each record
 *   adds a u16 length prefix, and the fixed 48-byte container header precedes
 *   all records.
 * - The helper pads the final partial 128-sample block and its flush loop
 *   appends one encoder-tail frame, so `frameCount` is
 *   ceil(sampleCount / 128) + 1 (verified against native ldac_helper output by
 *   the supplemental parity tests).
 *
 * Mono at 44.1 kHz is not part of either tier's encode policy and throws
 * instead of guessing a rate.
 */
export interface LdacContainerRateExpectation {
  readonly frameCount: number;
  readonly containerBytes: number;
  readonly measuredKbps: number;
}

export function expectedLdacContainerRate(
  sampleRateHz: 44_100 | 48_000,
  channels: 1 | 2,
  requestedBitrateKbps: 330 | 660 | 990,
  sampleCount: number,
): LdacContainerRateExpectation {
  if (sampleCount < 0 || !Number.isSafeInteger(sampleCount)) {
    throw new Error("LDAC rate expectation: invalid sample count");
  }
  let baseKbps: number;
  if (sampleRateHz === 44_100) {
    if (channels === 1) {
      throw new Error("LDAC rate expectation: mono at 44.1 kHz is not part of either tier's policy");
    }
    switch (requestedBitrateKbps) {
      case 330: baseKbps = 303; break;
      case 660: baseKbps = 606; break;
      case 990: baseKbps = 909; break;
      default: throw new Error(`LDAC rate expectation: unsupported quality ${String(requestedBitrateKbps)}`);
    }
  } else {
    baseKbps = channels === 1 ? requestedBitrateKbps / 2 : requestedBitrateKbps;
  }
  // libldac emits a transport frame whose total length is ceil(base bytes per
  // 128-sample frame). Empirically (six verified container sizes where WASM
  // and native ldac_helper output are byte-equal) that length already accounts
  // for the 3-byte LDAC transport header: 990->330, 909->330, 606->220,
  // 660->220, 303->110, mono 330->55, mono 660->110.
  const frameBytes =
    Math.ceil((baseKbps * 1000 * LDAC_FRAME_SAMPLES) / (sampleRateHz * 8));
  const frameCount = Math.ceil(sampleCount / LDAC_FRAME_SAMPLES) + 1;
  const containerBytes = LDAC_HEADER_SIZE +
    frameCount * (LDAC_RECORD_PREFIX_BYTES + frameBytes);
  const measuredKbps = (containerBytes * 8) / (sampleCount / sampleRateHz) / 1000;
  return Object.freeze({ frameCount, containerBytes, measuredKbps });
}
