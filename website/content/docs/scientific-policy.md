---
title: Scientific policy
description: How Audivane prepares, verifies, blinds and scores a comparison — and precisely what its evidence does and does not establish.
order: 2
updated: 2026-11-06
source: docs/methodology.md
source_sha256: c9a2bddf899fe7bf639907940a7d630d10d94694e16424af0c7ec582f9d56e43
---

Audivane prepares two codec chains from one decoded source, then runs a
fixed-trial blind ABX comparison. Audio stays local. The desktop app runs
native codecs in a private worker; the browser app uses local WASM codecs.
This page is the public statement of the rules the app enforces.

## Preparation and delivery

- Mono/stereo layout and the explicit session-rate policy are preserved. Both
  chains start from the same decoded source, including when that source is
  lossy.
- The `aligned-gain-matched-v1` preparation aligns the pair, applies constant
  gain matching and a common peak trim, and records its actual cropping, gains
  and trim.
- Alignment, loudness arithmetic order and PCM16 quantization semantics are
  frozen. A change to scientific meaning requires deliberate policy and schema
  versioning.
- Audivane measures the final delivered PCM and verifies its exact bytes,
  sample rate, channels and frame count independently before binding it to a
  listening run.
- Pair relation, preparation validity and delivered validity are versioned
  separately. Historical evidence cannot authorize current scoring.
- Over-limit or malformed audio is refused. A decoder-capped prefix is never
  accepted as a complete source. See [audio formats and
  limits](/docs/audio-formats-and-limits/).

## Listening and scoring

**Prepare test** verifies the pair and stages trial 1 paused. **Play** is
explicit. An A/B/X set must be complete and verified. An advancing trial has no
answer authority or selected label until its explicit pick switches to that
set. Pause and End remain effective during pending work.

The plan locks when the first trial is staged. Exactly the planned trial count
is scored; an incomplete or permanently ended run is not a final result. Exports
taken while a run is still going are redacted. Completed, sealed and void runs
each retain audit evidence under their distinct lifecycle rules, and stay
visibly distinct in the app.

Calibration is off by default. When you request it, it uses a separate first
trial of at most ten seconds of prepared side A, which is excluded from the
scored trial count. Canary material, listener calibration, preparation validity
and null gates are separate checks; none can silently substitute for another.

The experiment engine owns blinding, the fixed-N binomial decision, confidence
intervals and run evidence. The interface does not infer answers or score from
playback labels.

## What the evidence establishes

Audivane's checks are designed to be verifiable: intended behavior is validated
with analytical fixtures, applicable independent references and exact delivered
audio. Agreement between implementations or passing existing tests can preserve
the same defect, so neither is treated as proof on its own.

Two boundaries follow from this, and they are stated wherever results appear:

- **Validity is not audibility.** A passing preparation and a completed run
  establish that the comparison was constructed and scored as described. They
  do not certify audibility, codec conformance, tamper-proof operation or
  exclusive/bit-perfect output.
- **Digital capture is not the physical chain.** Digital checks verify bounded
  routing and playback behavior. Physical headphones, device wiring, drivers
  and OS or Bluetooth processing need separate listening checks — your
  hardware and listening conditions remain part of the experiment.

A result from Audivane is evidence about *your* files, *your* machine and
*your* hearing on the day of the test. It is not a general verdict about a
codec.
