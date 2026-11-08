---
title: Run your first ABX test
description: A step-by-step walkthrough of a full comparison — import audio, configure two chains, prepare, listen blind, and read the evidence.
order: 1
updated: 2026-11-08
source: apps/client/DESIGN.md
---

The same flow works in the desktop and browser workbench; only where codecs
run differs.

## 1. Pick your output

The sidebar shows your output route. Choose the device you will actually
listen on — headphones, speakers or an interface — before anything else.
Changing the route after the plan locks blocks continuation until you reset,
because the test would no longer describe the path the audio takes.

## 2. Import audio you know

Import a local file (WAV, FLAC, MP3, M4A/AAC, Ogg or Opus; up to 512 MiB and
30 minutes). Pick a dense, familiar track — something you have heard many
times. See [formats and limits](/docs/audio-formats-and-limits/) for the
details.

## 3. Configure side A and side B

In **Setup**, each side holds a codec chain — for example AAC at one bitrate
on side A and Opus on side B. Let the codec be the only variable.

The sidebar fixes the number of scored trials. Pick the count **before** you
start; the [results guide](/guides/understanding-your-results/) covers how to
choose it. Optional calibration stays off by default and never counts toward
your score.

## 4. Prepare the test

Press **Prepare test**. The app aligns the pair, matches gain, verifies the
exact delivered audio, and stages trial 1 **paused**. It never starts playing
by itself. If preparation refuses something, the message names the problem and
the fix.

## 5. Listen

In **Listen**, press **Play**. Use the A/B/X selectors to move between the two
references and the unknown sample, and loop a passage if that helps. The
question for every trial is “Is X A or B?” — answer once you have settled.

End the run with **End test** if conditions collapse. That run is sealed as an
incomplete record, which is simply not a result.

## 6. Read the evidence

A completed run opens **Evidence**: the plan you committed to, per-trial
answers, the binomial result, the preparation report, and the verified hashes
of the exact audio you were served. This is also where you export the run.

One note for first runs: on familiar music, transparent codecs are hard, and
one completed run is a data point — not a verdict.
