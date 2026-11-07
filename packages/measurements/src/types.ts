import type { LevelMeasurement } from "@codec-abx/contracts";

/** Rates this numerical slice is allowed to measure. Others are rejected. */
export const SUPPORTED_SAMPLE_RATES = [44100, 48000, 96000] as const;
export type SupportedSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];

/** Reference defaults from core.alignment.estimate_lag. */
export const DEFAULT_MAX_LAG_SAMPLES = 96000;
export const DEFAULT_PROBE_SAMPLES = 240000;

/**
 * Planar float PCM. Every channel has the same length and there is at least
 * one frame. Values are amplitude, not dBFS, and are never mutated here.
 */
export interface PcmAudio {
  readonly sampleRate: number;
  readonly channels: readonly Float64Array[];
}

/** Layout facts an already-validated strict WAV adapter supplies. */
export interface Pcm16Layout {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly dataOffset: number;
  readonly dataSize: number;
}

export interface PairMeasurementOptions {
  /** Inclusive absolute lag bound in samples. Defaults to 96000. */
  readonly maxLagSamples?: number;
  /** Shared probe length in samples. Defaults to 240000; must be at least 2. */
  readonly probeSamples?: number;
}

export interface AlignmentMeasurement {
  /** Positive means B is delayed relative to A. No samples were shifted. */
  readonly lagSamples: number;
  readonly confidence: number;
  readonly status: "estimated" | "no-evidence";
  readonly maxLagSamples: number;
  readonly probeSamples: number;
}

export interface NullMeasurement {
  readonly basis: "unshifted-common-prefix";
  readonly comparedFrames: number;
  readonly depthDb: LevelMeasurement;
}

/** AC RMS in both full-scale and PCM16 code-step units. */
export interface RelationAcRms {
  readonly fullScale: number;
  readonly codeSteps: number;
}

/** One distinct local positive correlation peak. Not a probability. */
export interface RelationPeak {
  readonly lagSamples: number;
  readonly confidence: number;
}

export interface RelationHypothesis {
  readonly polarity: "same" | "inverted";
  /** Positive means B is delayed relative to A. */
  readonly lagSamples: number;
  /** Clipped normalized correlation in [0, 1], not probability. */
  readonly confidence: number;
  readonly status: "estimated" | "no-evidence";
  /** Raw sign-adjusted cross-correlation sum at the chosen lag. */
  readonly rawCorrelationSum: number;
  readonly atSearchBoundary: boolean;
  /** Top distinct local positive peaks, sorted by descending confidence. */
  readonly peaks: readonly RelationPeak[];
}

/** Exact inputs and outputs needed to re-evaluate the relation later. */
export interface PairRelationReport {
  readonly policy: "pair-relation-v1";
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Whole common-prefix frame count used for AC RMS, before any probe advance. */
  readonly comparedFrames: number;
  /** Requested inclusive absolute lag bound in samples. */
  readonly maxLagSamples: number;
  /** Requested probe length in samples. */
  readonly probeSamples: number;
  /** Effective lag range after limiting to the available correlation span. */
  readonly searchRange: {
    readonly minLagSamples: number;
    readonly maxLagSamples: number;
  };
  readonly probe: {
    readonly startFrame: number;
    readonly frames: number;
    readonly fftSize: number;
    readonly energyA: number;
    readonly energyB: number;
    /** sqrt(energyA * energyB), the correlation denominator. */
    readonly normalization: number;
    readonly centering: "first-sample-compensated-mean-v1";
  };
  readonly acRms: {
    readonly a: RelationAcRms;
    readonly b: RelationAcRms;
  };
  readonly same: RelationHypothesis;
  readonly inverted: RelationHypothesis;
  readonly chosen: {
    readonly polarity: "same" | "inverted";
    readonly lagSamples: number;
    readonly confidence: number;
    readonly status: "estimated" | "no-evidence";
    readonly atSearchBoundary: boolean;
  };
  readonly notes: readonly string[];
}
