# Local audio import and long tracks

The browser and desktop workbench accept WAV, FLAC, MP3, M4A/MP4 audio,
ADTS AAC and Ogg/Opus (`.ogg`, `.oga`, `.opus`). Browser classification uses
container signatures rather than file names or MIME types; desktop selects an
explicit demuxer from the extension and requires matching probe facts. Neither
path accepts playlists or remote media references.

## Resource envelope

The shared constants are in `packages/contracts/src/audio-limits.ts`:

| Boundary | Limit |
| --- | --- |
| Original local file | 512 MiB |
| Nominal track duration | 1800 seconds |
| Decoded source end-padding budget | 0.1 seconds |
| Final delivery, including accumulated codec padding | 1800.5 seconds |
| One canonical PCM16 WAV (96 kHz stereo, 1800.5 s) | 691,392,044 bytes |
| Retained A/B and calibration material | 1,390,464,176 bytes |
| Calibration material | First `min(10 seconds, prepared Side A)` |

The WAV and retained limits are derived from the maximum supported layout, not
rounded: `44 + ceil(1800.5 * 96000) * 2 channels * 2 bytes` for one delivery,
two deliveries plus the pristine/degraded ten-second canary pair for retention,
and the 1810 s refusal-sentinel frames for one native Float64 decoded side
(2,780,160,000 bytes). A full 1800.5 s 96 kHz stereo delivery is about 691.4 MB
per side; two sides plus canaries are about 1.39 GB of retained PCM16.

The small padding budgets are refusal ceilings. They do not imply the extra
samples are silent and are never instructions to crop. An AAC stream can decode
a little longer than its advertised duration; accepted samples remain in the
prepared comparison. The existing alignment policy still crops codec
latency and unequal endings, reporting its actual operations. Files beyond the
resource envelope are refused, rather than served as shortened excerpts.

Both decoders have time and output-byte guards before accepting decoded audio.
The time guard is an 1810-second sentinel, deliberately beyond every acceptance
ceiling: reaching it cannot turn an overlong file into an accepted prefix. The
browser FFmpeg output cap sits above the canonical WAV ceiling so a legitimate
maximum-layout decode is not truncated at the same boundary it must pass; the
native per-side Float64 cap likewise includes the sentinel frames.
Decoded frames decide duration; ffprobe/FFmpeg container durations can be
estimates, particularly for ADTS. Complete linear WAV structure is checked
before browser normalization, and decoding errors fail the import.

## Source and comparison semantics

Both A/B chains start from one decoded source snapshot. For example, an MP3
input can feed AAC on Side A and Opus on Side B. The source SHA-256 always
covers the original selected file. Each delivered WAV has its own hash and
per-stage codec provenance.

Browser FFmpeg normalizes compressed and higher-precision WAV sources once to
PCM16; high precision is explicitly quantized. Supported source precision
includes 32-bit integer and 32/64-bit float WAV, plus FLAC at the bit depths the
pinned FFmpeg build supports; no bit depth is invented where the decoder cannot
represent it. Existing valid PCM16 WAV samples are adopted unchanged. Native
FFmpeg decodes to Float64 for its codec pipeline. Neither path claims to restore
information lost in a lossy source, recover precision removed by the canonical
PCM16 snapshot, or produce identical native/WASM codec output. FFmpeg owns
float-to-PCM16 clamping and non-finite handling in the browser canonical decode;
the native Float64 path rejects
non-finite decoded samples instead. Those are existing conversion policies, not
new restoration claims, and this app adds no second sanitization pass.

Mono/stereo is preserved. Native-rate mode permits 44.1, 48 and 96 kHz;
other source rates need explicit 48 kHz conversion. Multichannel sources are
refused instead of silently downmixed. Browser source decoding uses FFmpeg,
not `decodeAudioData`, so the browser audio device cannot silently choose the
import rate. Web Audio's eventual output-device resampling is reported
separately during playback.

The frozen canary FFT still operates on at most ten seconds. Long-track
calibration uses exactly the leading prepared Side A PCM payload and states
the selected frames in its report. Producer validation and experiment authority
check the pristine prefix independently; a same-length suffix is not valid
calibration material. Calibration does not shorten scored A/B audio.

## Memory and verification

1800 s of 96 kHz stereo is about 691 MB per PCM16 side, or 2.76 GB per Float64
side. The native shared-preparation pass can hold about 5.53 GB of Float64 pair
audio before serializing two 691 MB PCM16 deliveries, and A/B/X playback keeps
about 4.15 GB of Float32 audio before Web Audio output buffers. Import/resource
limits are policy ceilings, not a guarantee that every host or browser renderer
can allocate the largest layout. WebAssembly/renderer memory exhaustion is
refused with actionable guidance and never reported as shortened success.
Shorter sources, explicit 48 kHz delivery and mono material reduce the working
set.

The implementation avoids full gained/trimmed Float64 copies, streams
K-weighted block accumulation without full filtered arrays, reuses decoded
audio during authority validation and decodes PCM16 directly into playback
Float32. Tests compare the frozen arithmetic and exact served bytes; the
historical loudness implementation is retained only under test sources.

Real-browser acceptance covers compressed inputs, renamed files, 24-bit/float
WAV, tagged FLAC, lossy-to-lossy chains, >16 MiB stereo material, full ten-minute
preparation and padded AAC binding/playback. The historical ten-minute, 96 kHz
stereo stress case can be checked serially with:

```bash
CODEC_ABX_TEST_MAXIMUM_AUDIO=1 CODEC_ABX_BROWSER_WORKERS=1 npm run test:browser -- tests/e2e/audio-import.spec.ts --project=chromium-production --grep 'entire ten-minute'
```

The same suite includes a real 601 s source beyond the former 600 s ceiling and
small analytical 32-bit integer/float WAV imports. Those establish digital
acceptance beyond the old envelope. The full thirty-minute maximum layout has
analytical capacity coverage, but has not been prepared end to end on this host.
These checks are not audibility, physical-device or arbitrary-host-memory claims.

This validates digital processing and staging on the development host. Human
listening and physical output-device acceptance remain separate. See the
[development guide](development.md).
