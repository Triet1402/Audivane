import type { AlignmentEstimate, LevelMeasurement } from "./measurements.js";

export type PreparationPolicyId =
  | "codec-probe-only"
  | "aligned-gain-matched-v1";

/** Applied operations, distinct from the measurements of the final delivery. */
export interface PairPreparationReport {
  readonly policy: "aligned-gain-matched-v1";
  readonly targetLufs: -16;
  readonly minimumDurationSeconds: 0.4;
  readonly maxLagSeconds: 0.1;
  readonly peakCeiling: number;
  /** Estimate used for the applied head trim and common tail crop. */
  readonly alignment: AlignmentEstimate & {
    readonly inputFramesA: number;
    readonly inputFramesB: number;
    readonly startFrameA: number;
    readonly startFrameB: number;
    readonly outputFrames: number;
  };
  readonly loudness: {
    /** Measured after alignment/cropping, before any gain. */
    readonly preA: LevelMeasurement;
    readonly preB: LevelMeasurement;
    readonly gainADb: number;
    readonly gainBDb: number;
    /** Nonnegative common attenuation, applied equally to both sides. */
    readonly commonTrimDb: number;
  };
  readonly serialization: {
    readonly format: "pcm16-le";
    readonly rounding: "floor";
    /** Frozen positive offset in PCM integer-code units before flooring. */
    readonly floorBiasCodeSteps: number;
    readonly dither: false;
  };
  readonly notes: readonly string[];
}
