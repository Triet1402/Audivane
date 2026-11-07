---
title: How blind ABX testing works
description: What an ABX test asks, why the labels stay hidden while you listen, and how Audivane keeps a codec comparison fair.
order: 1
updated: 2026-11-06
source: docs/methodology.md
source_sha256: c9a2bddf899fe7bf639907940a7d630d10d94694e16424af0c7ec582f9d56e43
---

An ABX test compares two processed versions of the same audio without letting
their names influence you. You hear two references with known labels — side A
and side B — and one unknown sample, X, which is one of them. The question for
each trial is always the same: **is X A or B?**

## Why the labels are hidden

Knowing a codec's name changes what you expect to hear. Codec marketing, brand
loyalty and forum threads all prime expectation, and expectation is powerful
enough to make transparent audio sound different or a lossy encode sound
transparent. An ABX test removes the labels from the listening moment. You
answer first, and the result is computed after the fact.

This is why Audivane asks the question the same way every trial — "Is X A or
B?" — and never shows which side X matched until you have answered.

## What makes the comparison fair

Blinding alone is not enough. If one sample is louder, longer or offset in
time, you can pick it out without hearing a single artifact. Audivane therefore
prepares the pair before you listen:

- Both chains start from the **same decoded source**, including when that
  source is itself a lossy file such as MP3.
- The `aligned-gain-matched-v1` preparation aligns the pair, applies constant
  gain matching and a common peak trim, and records its actual cropping, gains
  and trim.
- The final delivered audio is measured and its exact bytes, sample rate,
  channels and frame count are verified independently before the listening run
  starts.
- Preparing a test verifies the pair and stages the first trial **paused**.
  Pressing Play is always a separate, explicit action.

## Fixed trials, honest scoring

Before you listen, the test locks a fixed number of trials. Audivane scores
exactly that planned count. Stopping partway — after a lucky streak or a run of
misses — changes what the score means, so an early-ended run is kept visibly
separate from a completed one and is not a final result.

A completed run reports its result against the fixed trial count with
binomial statistics and confidence intervals. Each trial is a two-way choice,
so guessing lands on "correct" half the time; a small number of lucky answers
is not proof that you heard a difference. The [results
guide](/guides/understanding-your-results/) explains how to read the numbers.

## One machine, no uploads

Audivane runs entirely on your own machine. Your audio files are never
uploaded, and both codec chains run locally — native codecs in a private
worker on the desktop app, and local WASM codecs in the browser app.
