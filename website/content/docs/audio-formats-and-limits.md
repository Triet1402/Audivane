---
title: Audio formats and limits
description: Accepted file types, size and duration ceilings, sample-rate and channel policy, and what Audivane refuses rather than shortens.
order: 3
updated: 2026-11-08
source: docs/audio-import.md
source_sha256: 3e8f8d905645d6aa5438b157712c050ed2b0efee1ed0497c3848a8513551e18c
---

Audivane imports a local audio file, decodes it once, and runs both codec
chains from that single decoded source. Nothing is uploaded. This page is
exactly what is accepted and what is refused.

## Accepted formats

WAV, FLAC, MP3, M4A/MP4 audio, ADTS AAC and Ogg/Opus (`.ogg`, `.oga`,
`.opus`). The browser identifies files by container signature rather than file
name, so a renamed file is still handled correctly; the desktop app selects a
demuxer from the extension and requires the probe facts to match.

## Size and duration ceilings

| Boundary | Limit |
| --- | --- |
| Original local file | 512 MiB |
| Track duration | up to 30 minutes (1800 seconds) |
| Final delivered audio, including accumulated codec padding | 1800.5 seconds |

Files beyond these limits are **refused**, never served as shortened excerpts.
If a decoder produces slightly more audio than a container advertised — which
can happen with AAC — the extra samples are kept, not silently chopped.

A full 30-minute, 96 kHz stereo delivery takes about 691 MB per side before
playback buffers; shorter sources, an explicit 48 kHz delivery and mono
material reduce the working set. If the browser runs out of memory, the import
fails with actionable guidance rather than reporting shortened success.

## Sample rate and channels

- Mono stays mono and stereo stays stereo; multichannel sources are refused,
  not silently downmixed.
- Native-rate mode accepts 44.1, 48 and 96 kHz. Other source rates need an
  explicit 48 kHz conversion, which you choose — nothing is resampled
  silently.
- Browser decoding runs through FFmpeg, not the browser's own audio stack, so
  your audio device cannot choose the import rate. Output-device resampling
  during playback is reported separately.

## Precision

- Existing valid PCM16 WAV files are adopted unchanged. 32-bit integer and
  float WAV sources are explicitly quantized into the canonical PCM16
  delivery; FLAC is decoded at the bit depths the bundled FFmpeg supports.
- If your source is itself lossy — an MP3, for example — both chains start
  from that same decoded lossy source. Audivane never claims to restore
  information a lossy file already lost.

Every prepared side is a canonical PCM16 WAV at the selected session rate,
with its own SHA-256 hash and per-stage codec provenance recorded in the
evidence view.
