export interface PcmCapture {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly samples: Int16Array;
}

export interface ActiveSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
}

export function decodePcm16(bytes: Uint8Array, sampleRate: number, channels: 1 | 2): PcmCapture;
export function readWav(file: string): PcmCapture;
export function channelData(capture: PcmCapture, channel: number): Float32Array;
export function rms(capture: PcmCapture, channel: number, startSeconds: number, endSeconds: number): number;
export function peak(capture: PcmCapture, channel: number, startSeconds: number, endSeconds: number): number;
export function dbfs(amplitude: number): number;
export function maxDbfs(capture: PcmCapture, channel: number, startSeconds: number, endSeconds: number): number;
export function toneAmplitude(capture: PcmCapture, channel: number, startSeconds: number, endSeconds: number, frequency: number): number;
export function channelCorrelation(capture: PcmCapture, startSeconds: number, endSeconds: number): number;
export function findActiveSegments(capture: PcmCapture, options?: {
  thresholdDbfs?: number;
  mergeGapSeconds?: number;
  minimumDurationSeconds?: number;
}): ActiveSegment[];
export function assertSilence(capture: PcmCapture, startSeconds: number, endSeconds: number, options?: {
  maxDbfs?: number;
  maxAmplitude?: number;
  label?: string;
}): number;
export function assertTone(capture: PcmCapture, channel: number, startSeconds: number, endSeconds: number, frequency: number, options?: {
  minAmplitude?: number;
  label?: string;
}): number;
export function assertChannelIsolation(capture: PcmCapture, startSeconds: number, endSeconds: number, options: {
  activeChannel: number;
  otherChannel: number;
  frequency: number;
  minAmplitude?: number;
  maxLeakRms?: number;
  label?: string;
}): { amplitude: number; leak: number };
export function assertAntiPhase(capture: PcmCapture, startSeconds: number, endSeconds: number, options?: {
  maxCorrelation?: number;
  minRms?: number;
  label?: string;
}): { correlation: number; left: number; right: number };
export function encodeWav(samples: Int16Array, sampleRate: number, channels: 1 | 2): Buffer;

export interface PeakMeasurement {
  readonly peakAmplitude: number;
  readonly status: 'finite' | 'negative-infinity';
  readonly dbfs: number | null;
}
export function peakMeasurement(amplitude: number): PeakMeasurement;
export interface SoftwareRoutingTiming {
  readonly playAtMs: number;
  readonly moveRequestedAtMs: number;
  readonly moveConfirmedAtMs: number;
  readonly pauseAtMs: number;
  readonly firstDataAtMsA: number;
  readonly firstDataAtMsB: number;
}
export function assertSoftwareSinkRouting(a: PcmCapture, b: PcmCapture, timing: SoftwareRoutingTiming,
  options?: { readonly guardSeconds?: number }): {
    readonly clockBasis: string;
    readonly guardSeconds: number;
    readonly windowsA: { before: readonly [number, number]; after: readonly [number, number] };
    readonly windowsB: { before: readonly [number, number]; after: readonly [number, number] };
    readonly segmentsA: readonly ActiveSegment[];
    readonly segmentsB: readonly ActiveSegment[];
    readonly routedAAmplitude: number;
    readonly routedBAmplitude: number;
    readonly wrongSinkBLeading: PeakMeasurement;
    readonly wrongSinkATrailing: PeakMeasurement;
  };

export function assertControlSilence(capture: PcmCapture,
  timing: { firstDataAtMs: number; afterAtMs: number; beforeAtMs?: number },
  options?: { guardSeconds?: number; label?: string }): {
    clockBasis: string; guardSeconds: number; window: readonly [number, number]; measurement: PeakMeasurement;
  };
