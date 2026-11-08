<img src="assets/brand/audivane-mark.svg" width="72" height="72" alt="Audivane logo">

# Audivane

Blind audio comparisons. Prepare two codec chains from a local audio file,
then compare them in a blind ABX listening test.

Audio processing stays on your machine. The browser uses WASM codecs; the
Electron desktop app uses native codecs.

**Version:** `0.2.0`. This update simplifies
Setup, Listen and Evidence, fixes post-run audio previews and downloads, and
combines listening records with diagnostics in one export.
See the [0.2.0 release notes](docs/release-notes-0.2.0.md).

Download desktop packages and matching source materials from
[GitHub Releases](https://github.com/Triet1402/Audivane/releases/tag/0.2.0).
See [release readiness](docs/releasing.md) for build and publication status.

## Try it from source

Use Node 24 (tested), or Node >=22.12:

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. See [development setup](docs/development.md) for
desktop prerequisites, optional browser codecs and verification.

## Run a comparison

1. Import a file and configure the Side A and Side B codec chains.
2. Select **Prepare test**. Audivane aligns and level-matches the pair, verifies
   the delivered bytes, and stages the first trial paused.
3. Select **Play**, compare A/B/X, and answer. The next trial stages automatically
   while the previous audio continues. Select A/B/X to hear the new trial.

The plan locks when the first trial is staged. Calibration is off by default;
the optional readiness check uses a separate first-ten-seconds trial, excluded
from the scored trial count. Running exports hide answers; completed and
permanently ended runs retain audit evidence.

The workspace has Setup, Listen and Evidence views, a persistent source/output/
plan sidebar, and System, Light and Dark themes.

## Supported audio and limits

- WAV, FLAC, MP3, M4A/MP4, ADTS AAC and Ogg/Opus, up to **30 minutes / 512 MiB**.
- Mono and stereo; supported 32-bit source PCM is accepted. Final listening
  delivery is PCM16 WAV.
- Preserve-input rates of 44.1, 48 and 96 kHz, with explicit 48 kHz conversion
  for other source rates.
- Nine codecs through the pinned browser FFmpeg build; LC3 and LDAC through
  optional separately built modules. Desktop availability follows its native bundle.

Both chains start from the same decoded source. Decoding lossy audio cannot
restore discarded information. The largest allowed track layouts have analytical
coverage; memory availability on every machine is not guaranteed.

See [audio import](docs/audio-import.md) for exact limits and rate policy.

## Scientific scope

Audivane records preparation, final audio identity and fixed-trial ABX results.
A numerical validity pass is not proof of audibility or codec conformance.
Hardware routing, OS processing and Bluetooth behavior require separate checks.
Server processing and persistence are not implemented.

## Documentation

- [Documentation index](docs/README.md): current guides and technical references.
- [Development](docs/development.md): setup, source map and verification.
- [Release preparation](docs/releasing.md): artifacts, acceptance and publication.

## License

Project-owned code is [MIT licensed](LICENSE), copyright 2026 Triet (@Triet1402).
Dependencies and codec binaries retain their own licenses. See
[third-party notices](THIRD_PARTY_NOTICES.md) and [distribution materials](docs/distribution-licenses.md).
A complete distribution must not be described as MIT-only.
