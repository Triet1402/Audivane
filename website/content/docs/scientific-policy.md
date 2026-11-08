---
title: Scientific policy
description: How Audivane prepares, verifies, blinds and scores a comparison — and precisely what its evidence does and does not establish.
order: 2
updated: 2026-11-08
source: docs/methodology.md
source_sha256: c9a2bddf899fe7bf639907940a7d630d10d94694e16424af0c7ec582f9d56e43
---

Audivane prepares two codec chains from one decoded source, then runs a
fixed-trial blind ABX comparison. Audio stays local — native codecs in a
private worker on desktop, WASM codecs in the browser. These are the rules the
app enforces.

## Preparation

- Both chains start from the same decoded source, including when that source
  is lossy. Mono/stereo layout and the explicit session-rate policy are
  preserved.
- The `aligned-gain-matched-v1` preparation aligns the pair, applies constant
  gain matching and a common peak trim, and records its actual cropping, gains
  and trim. These semantics are frozen; changing their scientific meaning
  requires deliberate policy and schema versioning.
- The final delivered PCM is measured, and its exact bytes, sample rate,
  channels and frame count are verified independently before being bound to a
  listening run.
- Over-limit or malformed audio is refused. A decoder-capped prefix is never
  accepted as a complete source. See [audio formats and
  limits](/docs/audio-formats-and-limits/).

## Listening and scoring

- **Prepare test** verifies the pair and stages trial 1 paused; **Play** is
  explicit. Pause and End stay effective during pending work.
- The plan locks when the first trial is staged, and exactly the planned trial
  count is scored. An incomplete or permanently ended run is not a final
  result, and exports taken mid-run are redacted.
- Calibration is off by default. When enabled, it is a separate first trial of
  at most ten seconds of prepared side A, excluded from the scored count.
  Canary material, calibration, preparation validity and null gates are
  separate checks and none can substitute for another.
- The experiment engine owns blinding, the fixed-N binomial decision and
  confidence intervals. The interface never infers answers or scores from
  playback labels.

## What the evidence establishes

- **Validity is not audibility.** A passing preparation and a completed run
  establish that the comparison was constructed and scored as described. They
  do not certify audibility, codec conformance or tamper-proof output.
- **Digital checks are not the physical chain.** Physical headphones, wiring,
  drivers and OS or Bluetooth processing need separate listening checks —
  your hardware and listening conditions remain part of the experiment.

A result from Audivane is evidence about *your* files, *your* machine and
*your* hearing on the day of the test. It is not a general verdict about a
codec.
