/**
 * Pure shared-timeline math for all three labels.
 *
 * A loop is one [start, end) interval in seconds. Positions are normalized so
 * that every source consumes the exact same interval and wrap point.
 */
import type { PlaybackLoop } from "@codec-abx/contracts";

export const MIN_LOOP_SECONDS = 0.01;

export function clampPosition(position: number, duration: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(position, 0), duration);
}

/** Map a position into a looped region, preserving the exact [start, end) wrap. */
export function positionForLoop(
  position: number,
  loop: PlaybackLoop,
  duration: number,
): number {
  if (!loop.enabled) return clampPosition(position, duration);
  const start = clampPosition(loop.startSeconds, duration);
  const end = clampPosition(loop.endSeconds, duration);
  const length = end - start;
  if (length < MIN_LOOP_SECONDS) return start;
  if (!Number.isFinite(position)) return start;
  const relative = position - start;
  const wrapped = ((relative % length) + length) % length;
  return start + wrapped;
}

/** Advance a normalized base position by elapsed context seconds. */
export function advancePosition(
  basePosition: number,
  elapsedSeconds: number,
  loop: PlaybackLoop,
  duration: number,
): number {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const next = basePosition + elapsed;
  if (!loop.enabled) return clampPosition(next, duration);
  return positionForLoop(next, loop, duration);
}

/**
 * Coerce a preserved loop intent onto a new duration (for a subsequent trial).
 * Enabled intent stays enabled when the new clip can hold a valid interval.
 */
export function clampLoop(loop: PlaybackLoop, duration: number): PlaybackLoop {
  if (!loop.enabled || duration < MIN_LOOP_SECONDS) {
    return Object.freeze({
      enabled: false,
      startSeconds: 0,
      endSeconds: Math.max(0, duration),
    });
  }
  let start = clampPosition(loop.startSeconds, duration);
  let end = clampPosition(loop.endSeconds, duration);
  if (end - start < MIN_LOOP_SECONDS) {
    if (start + MIN_LOOP_SECONDS <= duration) {
      end = start + MIN_LOOP_SECONDS;
    } else {
      start = Math.max(0, duration - MIN_LOOP_SECONDS);
      end = duration;
    }
  }
  return Object.freeze({ enabled: true, startSeconds: start, endSeconds: end });
}

/** Strict validation used by explicit setLoop controls before any state change. */
export function validateLoop(
  loop: PlaybackLoop,
  duration: number,
): PlaybackLoop {
  if (typeof loop !== "object" || loop === null) {
    throw new RangeError("loop must be an object");
  }
  if (typeof loop.enabled !== "boolean") {
    throw new RangeError("loop.enabled must be a boolean");
  }
  if (!Number.isFinite(loop.startSeconds) || !Number.isFinite(loop.endSeconds)) {
    throw new RangeError("loop bounds must be finite");
  }
  if (loop.startSeconds < 0) {
    throw new RangeError("loop start must not be negative");
  }
  if (!loop.enabled) {
    return Object.freeze({ enabled: false, startSeconds: 0, endSeconds: duration });
  }
  if (loop.endSeconds <= loop.startSeconds) {
    throw new RangeError("loop end must be greater than its start");
  }
  if (loop.endSeconds - loop.startSeconds < MIN_LOOP_SECONDS) {
    throw new RangeError(`loop interval must be at least ${MIN_LOOP_SECONDS} seconds`);
  }
  const start = loop.startSeconds;
  const end = loop.endSeconds;
  if (start > duration) {
    throw new RangeError("loop start is outside the loaded clip");
  }
  const clampedEnd = Math.min(end, duration);
  if (clampedEnd - start < MIN_LOOP_SECONDS) {
    throw new RangeError("loop interval is outside the loaded clip");
  }
  return Object.freeze({ enabled: true, startSeconds: start, endSeconds: clampedEnd });
}
