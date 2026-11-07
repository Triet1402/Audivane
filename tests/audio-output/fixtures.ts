/** Deterministic PCM16 fixtures shared by the browser and Electron capture specs. */
export type CaptureFixture = "channels" | "markers" | "continuous" | "continuousNext";

export const CHANNELS_ONSET_SECONDS = 0.2;
export const MARKER_SEEK_SECONDS = 1.0;
export const LOOP_START_SECONDS = 1.0;
export const LOOP_END_SECONDS = 1.3;

const SAMPLE_RATE = 48_000;

function amplitudeAt(kind: CaptureFixture, time: number, channel: 0 | 1): number {
  const sine = (frequency: number, amplitude: number): number =>
    amplitude * Math.sin(2 * Math.PI * frequency * time);
  if (kind === "channels") {
    if (time >= 0.2 && time < 0.6) return channel === 0 ? sine(440, 0.45) : 0;
    if (time >= 0.6 && time < 1.0) return channel === 1 ? sine(660, 0.45) : 0;
    if (time >= 1.0 && time < 1.4) return sine(880, 0.45) * (channel === 0 ? 1 : -1);
    if (time >= 1.6 && time < 10.0) return sine(1000, 0.35);
    return 0;
  }
  if (kind === "markers") {
    if (time >= 0.2 && time < 0.8) return sine(440, 0.35);
    if (time >= 1.0 && time < 1.3) return sine(1000, 0.35);
    if (time >= 1.7 && time < 2.0) return sine(1200, 0.35);
    return 0;
  }
  if (kind === "continuousNext") return sine(880, 0.4);
  return sine(440, 0.4);
}

export function captureFixtureSeconds(kind: CaptureFixture): number {
  return kind === "channels" ? 10.0 : kind === "markers" ? 2.4 : 5.0;
}

export function makeCaptureWav(kind: CaptureFixture): Uint8Array {
  const seconds = captureFixtureSeconds(kind);
  const frames = Math.round(SAMPLE_RATE * seconds);
  const dataSize = frames * 2 * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    for (let channel = 0; channel < 2; channel += 1) {
      const value = Math.max(-1, Math.min(1, amplitudeAt(kind, time, channel as 0 | 1)));
      view.setInt16(44 + (frame * 2 + channel) * 2, Math.round(value * 32767), true);
    }
  }
  return bytes;
}
