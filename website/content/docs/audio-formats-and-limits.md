---
title: Audio formats and limits
description: Accepted file types, size and duration ceilings, sample-rate and channel policy, and what Audivane refuses rather than shortens.
order: 3
updated: 2026-11-06
source: docs/audio-import.md
source_sha256: 3e8f8d905645d6aa5438b157712c050ed2b0efee1ed0497c3848a8513551e18c
---

Audivane imports a local audio file, decodes it once, and runs both codec
chains from that single decoded source. This page lists exactly what it accepts
and what it refuses. Nothing is uploaded or fetched remotely — playlists and
remote media references are not accepted on any platform.

## Accepted formats

The browser and desktop workbench accept WAV, FLAC, MP3, M4A/MP4 audio, ADTS
AAC and Ogg/Opus (`.ogg`, `.oga`, `.opus`).

The browser identifies files by container signature rather than by file name or
reported MIME type, so a renamed file is still handled correctly. The desktop
app selects an explicit demuxer from the extension and requires the probe facts
to match.

## Size and duration ceilings

| Boundary | Limit |
| --- | --- |
| Original local file | 512 MiB |
| Track duration | up to 30 minutes (1800 seconds) |
| Final delivered audio, including accumulated codec padding | 1800.5 seconds |

Files beyond the envelope are **refused**, not served as shortened excerpts.
Decoders carry deliberate time and byte guards before any audio is accepted, so
an overlong file can never quietly become an accepted prefix. If a decoder
produces slightly more audio than a container advertised — which can happen
with AAC — the accepted samples remain in the prepared comparison instead of
being silently chopped.

The largest layouts are memory-hungry: a full 30-minute, 96 kHz stereo delivery
is about 691 MB per side before playback buffers. Shorter sources, an explicit
48 kHz delivery and mono material reduce the working set. These limits are
policy ceilings, not a guarantee that every host or browser tab can allocate
the largest layout; if the browser runs out of memory, the import fails with
actionable guidance rather than reporting shortened success.

## Sample rate and channels

- Mono/stereo layout is preserved. Mono sources are not padded to stereo, and
  stereo sources are not collapsed.
- Native-rate mode permits 44.1, 48 and 96 kHz. Other source rates need an
  explicit 48 kHz conversion, which you choose — nothing is resampled silently.
- Multichannel sources are refused rather than silently downmixed.
- Browser source decoding runs through FFmpeg, not the browser's own audio
  stack, so your audio device cannot silently choose the import rate. Any
  output-device resampling that happens during playback is reported separately.

## Precision, and what conversion cannot do

- Existing valid PCM16 WAV files are adopted unchanged.
- 32-bit integer and 32/64-bit float WAV sources are supported, and their
  higher precision is **explicitly quantized** into the canonical PCM16
  listening delivery. FLAC files are decoded at the bit depths the bundled
  FFmpeg build actually supports; no bit depth is invented where the decoder
  cannot represent it.
- If your source is itself lossy — an MP3, for example — both chains start from
  that same decoded lossy source. Audivane never claims to restore information
  a lossy file already lost, and the desktop and browser codecs are not
  claimed to produce identical output.

Every prepared side is a canonical PCM16 WAV at the selected session rate, with
its own SHA-256 hash and per-stage codec provenance recorded in the evidence
view. The source file's hash always covers the original file you selected.
