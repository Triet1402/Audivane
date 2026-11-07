# Development

Use Node 24 (tested), or Node >=22.12. Install dependencies with `npm ci`.

## Browser

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Processing stays local. Build the optional LC3
and LDAC modules with `tools/build_codec_wasm.sh` before starting the client.
That script downloads emsdk on first use and records the compiler version.
Missing or invalid modules leave those codecs unavailable.

`npm run build:client` writes the production client to `apps/client/dist`.
Public web distribution also needs matching codec source and license materials;
see [licenses](distribution-licenses.md).

## Desktop

For desktop, provide native FFmpeg/ffprobe (and the LDAC helper for that codec),
then run:

```bash
npm run check:native
npm run build:desktop
npm run desktop
npm run package:desktop
```

`check:native` probes actual encoder/decoder support (`-- --json` for a report).
For local development, executable paths can be set with `CODEC_ABX_FFMPEG`,
`CODEC_ABX_FFPROBE` and `CODEC_ABX_LDAC_HELPER`; otherwise tools are discovered
on PATH. Missing capabilities refuse explicitly.

Release packages use an explicitly prepared native bundle:

```bash
npm run package:desktop -- --native-bundle /absolute/prepared/resources
```

Packaging does not download binaries or copy arbitrary PATH executables. See
[packaging](distribution-packaging.md) for Linux/Windows formats and materials,
and [desktop runtime](typescript-desktop-runtime.md) for sandbox and host setup.

## Verification

Run checks for the changed module and its callers while editing. Use one full
integration run after the combined change is ready.

```bash
npm run typecheck
npm run test:unit -- packages/experiment/test/chain.test.ts
npm run test:desktop:unit
npm run verify:full
```

The full lane includes browser/desktop acceptance and serial performance phases.
Native checks require the pinned codec prerequisites. Validate intended semantics
using analytical fixtures, independent evidence and exact delivered audio;
existing passes are not correctness authorities.

See [verification workflow](verification-workflow.md) for dependency setup,
scopes, build caches, artifacts and worker controls.

## Source map

| Directory | Purpose |
| --- | --- |
| `apps/client` | Shared browser and desktop UI |
| `apps/desktop` | Sandboxed Electron shell and private native worker |
| `packages` | Shared audio policy, experiment authority, playback and execution adapters |
| `tools` | Builds, verification, packaging and release preparation |

The [architecture decision](adr/0001-local-audio-runtime.md)
records the local processing architecture. Follow the [scientific policy](methodology.md)
and use the [documentation index](README.md) for current guides.

## Remote local preview

When exposing a local preview through a trusted reverse proxy, set
`CODEC_ABX_PREVIEW_ALLOWED_HOSTS` to its comma-separated hostnames before starting
Vite preview. The default has no extra allowed hosts. Keep private hostnames in
local environment configuration rather than tracked source.
