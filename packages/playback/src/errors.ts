/**
 * Stable playback refusals. Codes are public control-contract facts; messages
 * never contain listener answers, source identity or prepared audio bytes.
 */
export type PlaybackErrorCode =
  | "disposed"
  | "invalid-trial"
  | "invalid-reader"
  | "invalid-label"
  | "invalid-position"
  | "invalid-loop"
  | "invalid-context"
  | "invalid-device"
  | "invalid-listener"
  | "not-loaded"
  | "output-busy"
  | "audio-unavailable"
  | "context-closed"
  | "context-suspended"
  | "load-failed";

export class PlaybackError extends Error {
  readonly code: PlaybackErrorCode;

  constructor(code: PlaybackErrorCode, message: string) {
    super(message);
    this.name = "PlaybackError";
    this.code = code;
  }
}

export function playbackError(code: PlaybackErrorCode, message: string): never {
  throw new PlaybackError(code, message);
}
