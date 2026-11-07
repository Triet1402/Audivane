/**
 * Small, dependency-free PCM/WAV analyzer for the virtual-capture lane.
 *
 * It measures what the private sink monitor actually delivered. No analysis
 * here resamples, gates, normalizes or compares against preparation tolerances.
 */
import { readFileSync } from 'node:fs';

function ascii(buffer, offset) {
  return String.fromCharCode(
    buffer[offset] ?? 0,
    buffer[offset + 1] ?? 0,
    buffer[offset + 2] ?? 0,
    buffer[offset + 3] ?? 0,
  );
}

export function decodePcm16(bytes, sampleRate, channels) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('sample rate must be a positive integer');
  if (channels !== 1 && channels !== 2) throw new Error('only mono/stereo PCM16 is supported');
  if (bytes.byteLength % (channels * 2) !== 0) throw new Error('PCM16 byte count is not a whole frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = bytes.byteLength / (channels * 2);
  const samples = new Int16Array(frames * channels);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return { sampleRate, channels, frames, samples };
}

export function readWav(file) {
  const bytes = readFileSync(file);
  if (bytes.byteLength < 44) throw new Error('capture WAV is too short');
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') throw new Error('capture is not RIFF/WAVE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = null;
  let channels = null;
  let sampleRate = null;
  let bits = null;
  let dataOffset = null;
  let dataSize = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) throw new Error(`capture chunk ${id} exceeds the file`);
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) {
        if (view.getUint16(body + 24, true) === 1) format = 1;
      }
    }
    if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }
  if (format !== 1 || bits !== 16) throw new Error('capture WAV is not PCM16');
  if (channels !== 1 && channels !== 2) throw new Error('capture WAV is not mono/stereo');
  if (sampleRate === null || dataOffset === null || dataSize === null) throw new Error('capture WAV lacks fmt/data');
  return decodePcm16(bytes.subarray(dataOffset, dataOffset + dataSize), sampleRate, channels);
}

/** Normalized (-1..1) channel samples. */
export function channelData(capture, channel) {
  if (channel < 0 || channel >= capture.channels) throw new Error(`capture has no channel ${channel}`);
  const data = new Float32Array(capture.frames);
  for (let frame = 0; frame < capture.frames; frame += 1) {
    data[frame] = (capture.samples[frame * capture.channels + channel] ?? 0) / 32768;
  }
  return data;
}

function frameWindow(capture, startSeconds, endSeconds) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
      startSeconds < 0 || endSeconds <= startSeconds ||
      endSeconds > capture.frames / capture.sampleRate + 1e-9) {
    throw new Error('analysis window must contain recorded frames within the capture');
  }
  const start = Math.max(0, Math.min(capture.frames, Math.floor(startSeconds * capture.sampleRate)));
  const end = Math.max(start, Math.min(capture.frames, Math.ceil(endSeconds * capture.sampleRate)));
  return { start, end };
}

export function rms(capture, channel, startSeconds, endSeconds) {
  const data = channelData(capture, channel);
  return rmsData(data, capture.sampleRate, startSeconds, endSeconds);
}

function rmsData(data, sampleRate, startSeconds, endSeconds) {
  const start = Math.max(0, Math.min(data.length, Math.floor(startSeconds * sampleRate)));
  const end = Math.max(start, Math.min(data.length, Math.ceil(endSeconds * sampleRate)));
  if (end <= start) return 0;
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const value = data[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / (end - start));
}

export function peak(capture, channel, startSeconds, endSeconds) {
  const data = channelData(capture, channel);
  const { start, end } = frameWindow(capture, startSeconds, endSeconds);
  let maximum = 0;
  for (let index = start; index < end; index += 1) maximum = Math.max(maximum, Math.abs(data[index] ?? 0));
  return maximum;
}

export function dbfs(amplitude) {
  if (!(amplitude > 0)) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(amplitude);
}

export function maxDbfs(capture, channel, startSeconds, endSeconds) {
  return dbfs(peak(capture, channel, startSeconds, endSeconds));
}

/** Goertzel amplitude estimate at one frequency for one channel window. */
export function toneAmplitude(capture, channel, startSeconds, endSeconds, frequency) {
  const data = channelData(capture, channel);
  const { start, end } = frameWindow(capture, startSeconds, endSeconds);
  const count = end - start;
  if (count < 16) return 0;
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / capture.sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let index = start; index < end; index += 1) {
    const s0 = (data[index] ?? 0) + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / count;
}

/** Pearson correlation between two channels over a window. */
export function channelCorrelation(capture, startSeconds, endSeconds) {
  if (capture.channels !== 2) throw new Error('correlation requires a stereo capture');
  const left = channelData(capture, 0);
  const right = channelData(capture, 1);
  const { start, end } = frameWindow(capture, startSeconds, endSeconds);
  const count = end - start;
  if (count < 16) return 0;
  let sumL = 0;
  let sumR = 0;
  let sumLL = 0;
  let sumRR = 0;
  let sumLR = 0;
  for (let index = start; index < end; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    sumL += l;
    sumR += r;
    sumLL += l * l;
    sumRR += r * r;
    sumLR += l * r;
  }
  const covariance = sumLR / count - (sumL / count) * (sumR / count);
  const varianceL = sumLL / count - (sumL / count) ** 2;
  const varianceR = sumRR / count - (sumR / count) ** 2;
  const denominator = Math.sqrt(Math.max(0, varianceL) * Math.max(0, varianceR));
  return denominator > 0 ? covariance / denominator : 0;
}

/**
 * Locate active regions with a 10 ms envelope. Detection is intentionally
 * relative and threshold-based: OS/Pulse buffering shifts the capture but does
 * not change segment order or duration materially.
 */
export function findActiveSegments(capture, options = {}) {
  const thresholdDbfs = options.thresholdDbfs ?? -50;
  const mergeGapSeconds = options.mergeGapSeconds ?? 0.08;
  const minimumDurationSeconds = options.minimumDurationSeconds ?? 0.06;
  const threshold = 10 ** (thresholdDbfs / 20);
  const window = Math.max(1, Math.round(capture.sampleRate * 0.01));
  const raw = [];
  for (let start = 0; start < capture.frames; start += window) {
    const end = Math.min(capture.frames, start + window);
    let maximum = 0;
    for (let frame = start; frame < end; frame += 1) {
      for (let channel = 0; channel < capture.channels; channel += 1) {
        maximum = Math.max(maximum, Math.abs((capture.samples[frame * capture.channels + channel] ?? 0) / 32768));
      }
    }
    if (maximum >= threshold) raw.push({ start, end });
  }
  const merged = [];
  for (const segment of raw) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start - previous.end <= mergeGapSeconds * capture.sampleRate) {
      previous.end = segment.end;
    } else {
      merged.push({ start: segment.start, end: segment.end });
    }
  }
  return merged
    .map((segment) => ({
      startSeconds: segment.start / capture.sampleRate,
      endSeconds: segment.end / capture.sampleRate,
      durationSeconds: (segment.end - segment.start) / capture.sampleRate,
    }))
    .filter((segment) => segment.durationSeconds >= minimumDurationSeconds);
}

export function assertSilence(capture, startSeconds, endSeconds, options = {}) {
  const maximum = Math.max(...Array.from({ length: capture.channels }, (_, channel) =>
    peak(capture, channel, startSeconds, endSeconds)));
  const limit = options.maxAmplitude ?? 10 ** ((options.maxDbfs ?? -55) / 20);
  if (maximum > limit) {
    throw new Error(`${options.label ?? 'window'} was not silent: peak ${maximum.toFixed(6)} (${dbfs(maximum).toFixed(1)} dBFS) > ${limit.toFixed(6)}`);
  }
  return maximum;
}

export function assertTone(capture, channel, startSeconds, endSeconds, frequency, options = {}) {
  const amplitude = toneAmplitude(capture, channel, startSeconds, endSeconds, frequency);
  const minimum = options.minAmplitude ?? 0.05;
  if (!(amplitude >= minimum)) {
    throw new Error(`${options.label ?? frequency + ' Hz tone'} on channel ${channel} was missing: amplitude ${amplitude.toFixed(5)} < ${minimum}`);
  }
  return amplitude;
}

export function assertChannelIsolation(capture, startSeconds, endSeconds, options) {
  const amplitude = assertTone(capture, options.activeChannel, startSeconds, endSeconds, options.frequency, options);
  const leak = rms(capture, options.otherChannel, startSeconds, endSeconds);
  const leakLimit = options.maxLeakRms ?? 0.01;
  if (leak > leakLimit) {
    throw new Error(`${options.label ?? 'channel isolation'} leaked into channel ${options.otherChannel}: RMS ${leak.toFixed(5)} > ${leakLimit}`);
  }
  return { amplitude, leak };
}

export function assertAntiPhase(capture, startSeconds, endSeconds, options = {}) {
  if (capture.channels !== 2) throw new Error('anti-phase check requires stereo');
  const correlation = channelCorrelation(capture, startSeconds, endSeconds);
  const limit = options.maxCorrelation ?? -0.85;
  const left = rms(capture, 0, startSeconds, endSeconds);
  const right = rms(capture, 1, startSeconds, endSeconds);
  const minimum = options.minRms ?? 0.05;
  if (left < minimum || right < minimum) {
    throw new Error(`${options.label ?? 'anti-phase tone'} was too quiet: L ${left.toFixed(5)}, R ${right.toFixed(5)} < ${minimum}`);
  }
  if (!(correlation <= limit)) {
    throw new Error(`${options.label ?? 'anti-phase tone'} lost polarity: correlation ${correlation.toFixed(4)} > ${limit}`);
  }
  return { correlation, left, right };
}

/** Build a canonical PCM16 WAV from interleaved samples. */
export function encodeWav(samples, sampleRate, channels) {
  const dataSize = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(samples[index] ?? 0, 44 + index * 2);
  }
  return bytes;
}

/** JSON-safe measured peak; null dBFS means exact digital silence, never a tolerance. */
export function peakMeasurement(amplitude) {
  if (!Number.isFinite(amplitude) || amplitude < 0) throw new Error('invalid measured peak');
  return { peakAmplitude: amplitude, status: amplitude === 0 ? 'negative-infinity' : 'finite',
    dbfs: amplitude === 0 ? null : dbfs(amplitude) };
}

/**
 * Assert host/software routing against independent control timestamps.
 * Each recorder's first PCM delivery anchors its own sample clock; a fixed
 * 250 ms guard covers monitor delivery/mixer buffering, not detected signal.
 */
export function assertSoftwareSinkRouting(a, b, timing, options = {}) {
  const guard = options.guardSeconds ?? 0.25;
  const { playAtMs, moveRequestedAtMs, moveConfirmedAtMs, pauseAtMs, firstDataAtMsA, firstDataAtMsB } = timing;
  if (![playAtMs, moveRequestedAtMs, moveConfirmedAtMs, pauseAtMs, firstDataAtMsA, firstDataAtMsB, guard].every(Number.isFinite) ||
      guard < 0 || playAtMs >= moveRequestedAtMs || moveRequestedAtMs > moveConfirmedAtMs || moveConfirmedAtMs >= pauseAtMs) {
    throw new Error('invalid recorded routing control timestamps');
  }
  const windowsFor = (firstDataAtMs) => ({
    before: [(playAtMs - firstDataAtMs) / 1000 + guard, (moveRequestedAtMs - firstDataAtMs) / 1000 - guard],
    after: [(moveConfirmedAtMs - firstDataAtMs) / 1000 + guard, (pauseAtMs - firstDataAtMs) / 1000 - guard],
  });
  const windowsA = windowsFor(firstDataAtMsA), windowsB = windowsFor(firstDataAtMsB);
  for (const [capture, windows] of [[a, windowsA], [b, windowsB]]) {
    for (const window of [windows.before, windows.after]) {
      frameWindow(capture, ...window);
      if (window[1] - window[0] < 0.35) throw new Error('routing control window contains too little recorded audio');
    }
  }
  // These windows cannot move to exclude a leak: their bounds depend only on
  // controller events and recorder clock anchors, not on the observed waveform.
  const beforeB = assertSilence(b, ...windowsB.before, { label: 'sink B before requested move', maxDbfs: -55 });
  const afterA = assertSilence(a, ...windowsA.after, { label: 'sink A after confirmed move', maxDbfs: -55 });
  const beforeA = assertTone(a, 0, ...windowsA.before, 440, { label: 'sink A before move' });
  const afterB = assertTone(b, 0, ...windowsB.after, 440, { label: 'sink B after move' });
  const segmentsA = findActiveSegments(a), segmentsB = findActiveSegments(b);
  if (!segmentsA.length || !segmentsB.length) throw new Error('routing capture lacks active audio');
  if (segmentsB[0].startSeconds < (moveRequestedAtMs - firstDataAtMsB) / 1000 - guard) {
    throw new Error('sink B became active before the requested move');
  }
  if (segmentsA.at(-1).endSeconds > (moveConfirmedAtMs - firstDataAtMsA) / 1000 + guard) {
    throw new Error('sink A remained active after the confirmed move');
  }
  return { clockBasis: 'first-pcm-delivery-with-buffer-guard', guardSeconds: guard,
    windowsA, windowsB, segmentsA, segmentsB, routedAAmplitude: beforeA, routedBAmplitude: afterB,
    wrongSinkBLeading: peakMeasurement(beforeB), wrongSinkATrailing: peakMeasurement(afterA) };
}

/** Silence after a real control event, never after a detected signal boundary. */
export function assertControlSilence(capture, timing, options = {}) {
  const guard = options.guardSeconds ?? 0.25;
  if (![timing.firstDataAtMs, timing.afterAtMs, guard].every(Number.isFinite) || guard < 0 ||
      (timing.beforeAtMs !== undefined && !Number.isFinite(timing.beforeAtMs))) {
    throw new Error('invalid silence control timestamps');
  }
  const window = [(timing.afterAtMs - timing.firstDataAtMs) / 1000 + guard,
    timing.beforeAtMs === undefined ? capture.frames / capture.sampleRate - 0.05
      : (timing.beforeAtMs - timing.firstDataAtMs) / 1000 - 0.05];
  frameWindow(capture, ...window);
  if (window[1] - window[0] < 0.35) throw new Error('control silence window contains too little recorded audio');
  const measured = assertSilence(capture, ...window, { label: options.label, maxDbfs: -55 });
  return { clockBasis: 'first-pcm-delivery-with-buffer-guard', guardSeconds: guard,
    window, measurement: peakMeasurement(measured) };
}
