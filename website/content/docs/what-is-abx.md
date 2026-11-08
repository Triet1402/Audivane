---
title: How blind ABX testing works
description: What an ABX test asks, why the labels stay hidden while you listen, and how Audivane keeps a codec comparison fair.
order: 1
updated: 2026-11-08
source: docs/methodology.md
source_sha256: c9a2bddf899fe7bf639907940a7d630d10d94694e16424af0c7ec582f9d56e43
---

An ABX test compares two processed versions of the same audio without letting
their names influence you. You hear two references with known labels — side A
and side B — and one unknown sample, X, which is one of them. Each trial asks
the same question: **is X A or B?**

## Why the labels are hidden

Knowing a codec's name changes what you expect to hear, and expectation is
powerful enough to make transparent audio sound different or a lossy encode
sound transparent. An ABX test removes the labels from the listening moment:
you answer first, and the result is computed after the fact.

## What makes the comparison fair

Blinding alone is not enough. If one sample is louder, longer or offset in
time, you can pick it out without hearing a single artifact. So Audivane
prepares the pair before you listen:

- Both chains start from the **same decoded source**, even when that source is
  itself lossy.
- Preparation aligns the pair, applies constant gain matching and a common
  peak trim, and records the actual cropping, gains and trim.
- The final delivered audio is measured, and its exact bytes, sample rate,
  channels and frame count are verified before the run starts.
- The first trial is staged **paused**; pressing Play is always a separate
  action.

## Fixed trials, honest scoring

The test locks a fixed number of trials before you listen, and exactly that
count is scored. Stopping partway — after a lucky streak or a run of misses —
changes what the score means, so an early-ended run is kept visibly separate
and is not a final result.

Each trial is a two-way choice, so guessing is right half the time. A
completed run reports its result with binomial statistics and confidence
intervals; the [results guide](/guides/understanding-your-results/) explains
how to read them.

## One machine, no uploads

Audivane runs entirely on your own machine. Your audio files are never
uploaded, and both codec chains run locally — native codecs on desktop, WASM
codecs in the browser.
