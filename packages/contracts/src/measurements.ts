/** JSON-safe level value: null never stands alone for several different meanings. */
export type LevelMeasurement =
  | { readonly status: "finite"; readonly value: number; readonly reason: null }
  | { readonly status: "negative-infinity" | "undefined" | "unavailable";
      readonly value: null; readonly reason: string };

export interface AudioMeasurementSummary {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly integratedLufs: LevelMeasurement;
  /** Sample peak only; this is not an oversampled true-peak meter. */
  readonly samplePeakDbfs: LevelMeasurement;
}

/** Estimate on a particular PCM pair; its caller decides whether to apply it. */
export interface AlignmentEstimate {
  /** Positive means B is delayed relative to A in the pair used for this estimate. */
  readonly lagSamples: number;
  readonly confidence: number;
  readonly status: "estimated" | "no-evidence";
  readonly maxLagSamples: number;
  readonly probeSamples: number;
}

/** Measurements of serialized delivery, never a normalization/gate certificate. */
export interface DeliveredPairMeasurements {
  readonly policy: "delivered-pcm-measurements-v1";
  readonly a: AudioMeasurementSummary;
  readonly b: AudioMeasurementSummary;
  /** Residual estimate on delivered samples; this measurement applies no shift. */
  readonly alignment: AlignmentEstimate;
  readonly loudnessDeltaDb: LevelMeasurement;
  readonly nullDepth: {
    readonly basis: "unshifted-common-prefix";
    readonly comparedFrames: number;
    readonly depthDb: LevelMeasurement;
  };
  readonly notes: readonly string[];
}
