/**
 * @codec-abx/playback
 *
 * Shared playback controls with a browser Web Audio adapter. This package
 * never imports the experiment service, Node APIs or a network client.
 */
export { BrowserTrialPlayer, GAIN_RAMP_SECONDS, LIVE_SCHEDULE_LEAD_SECONDS } from "./player.js";
export type { BrowserTrialPlayerOptions } from "./player.js";
export { PlaybackError } from "./errors.js";
export type { PlaybackErrorCode } from "./errors.js";
export {
  MIN_LOOP_SECONDS,
  advancePosition,
  clampLoop,
  clampPosition,
  positionForLoop,
  validateLoop,
} from "./timeline.js";
export {
  CANONICAL_PCM16_HEADER_BYTES,
  MAX_CLIP_BYTES,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  decodeCanonicalPcm16,
} from "./wav.js";
export type { DecodedClip } from "./wav.js";
