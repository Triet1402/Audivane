# Scientific policy

Audivane prepares two codec chains from one decoded source, then runs a
fixed-trial blind ABX comparison. Audio stays local. The desktop runs native
codecs in a private worker; the browser uses local WASM codecs.

## Preparation and delivery

- Preserve mono/stereo and the explicit session-rate policy. Both chains start
  from the same decoded source, including when that source is lossy.
- `aligned-gain-matched-v1` aligns the pair, applies constant gain matching and
  a common peak trim. Record actual cropping, gains and trim.
- Freeze alignment, loudness arithmetic order and PCM16 quantization semantics.
  A change to scientific meaning requires deliberate policy/schema versioning.
- Measure the final delivered PCM. Verify its exact bytes, sample rate, channels
  and frame count independently before binding it to a listening run.
- Keep pair relation, preparation validity and delivered validity separately
  versioned. Historical evidence cannot authorize current scoring.
- Refuse over-limit or malformed audio. Never accept a decoder-capped prefix
  as a complete source. See [audio limits](audio-import.md).

Core implementation lives in `packages/measurements`, `packages/preparation-policy`,
`packages/experiment` and `packages/playback`. Codec adapters live in
`packages/engine-browser` and `packages/engine-native`.

## Listening and scoring

**Prepare test** verifies the pair and stages trial 1 paused. **Play** is explicit.
A/B/X must be a complete verified set. An advancing trial has no answer authority
or selected label until its explicit pick switches to that set. Pause and End
remain effective during pending work.

The plan locks when the first trial is staged. Score exactly the planned trial
count; an incomplete or permanently ended run is not a final result. Keep
running exports redacted. Completed, sealed and void runs retain audit evidence
under their distinct lifecycle rules.

Calibration defaults off. When requested, it uses a separate first
`min(10 seconds, prepared Side A)` trial, excluded from scored N. Canary
material, listener calibration, preparation validity and null gates are separate
checks; none can silently substitute for another.

The experiment implementation owns blinding, the fixed-N binomial decision,
confidence intervals and run evidence. The UI does not infer answers or score
from playback labels. Preserve the analytical statistical fixtures when changing
these calculations.

## What the evidence establishes

Validate intended semantics with analytical fixtures, applicable independent
references and exact delivered audio. Agreement between implementations or
passing existing tests can preserve the same defect.

Digital capture verifies bounded routing and playback behavior. Physical
headphones, device wiring, drivers and OS/Bluetooth processing need separate
listening checks. Numerical validity does not certify audibility, codec
conformance, tamper-proof operation or exclusive/bit-perfect output.

See [verification](verification-workflow.md) and [installed acceptance](distribution-acceptance.md)
for the required checks. Build success and historical tests do not establish
acceptance of a newly rebuilt artifact.
