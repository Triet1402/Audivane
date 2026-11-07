# Local audio runtime

Use shared TypeScript policy, measurements, experiment authority and playback
in the browser and Electron desktop app. Browser workers execute local WASM
codecs. A private desktop worker executes native FFmpeg and codec helpers.

Keep OS file access and process ownership behind narrow platform interfaces.
Preserve renderer sandboxing, cancellation, cleanup and exact delivered-byte
authority. Processing stays local; server execution and persistence are deferred.

Shared policy does not promise native/WASM codec equality. Validate intended
semantics with analytical fixtures, independent evidence and exact delivered
audio. Scientific changes require explicit policy/schema versioning.
