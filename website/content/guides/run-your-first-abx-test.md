---
title: Run your first ABX test
description: A step-by-step walkthrough of a full comparison — import audio, configure two chains, prepare, listen blind, and read the evidence.
order: 1
updated: 2026-11-06
source: apps/client/DESIGN.md
---

This guide follows the desktop or browser workbench from an empty screen to a
completed run. The two share the same flow; only where codecs run differs
(native worker on desktop, WASM in the browser).

## 1. Open the workbench and pick your output

The app runs on your machine. The sidebar always shows your output route,
starting at **System default output**. Choose the device you will actually
listen on — headphones, speakers or an interface — before anything else.
Changing the route after the plan locks pauses playback and blocks continuation
until you reset, because the test would no longer describe the path the audio
takes.

## 2. Import audio you know

Import a local file in an accepted format (WAV, FLAC, MP3, M4A/AAC, Ogg or
Opus; up to 512 MiB and 30 minutes). Pick something you like and have heard
many times — a dense, familiar track is better for finding differences than a
sparse one. The app shows the decoded channel count and rate; if your rate
needs it, you decide on the explicit 48 kHz conversion. See
[formats and limits](/docs/audio-formats-and-limits/) for the details.

## 3. Configure side A and side B

In **Setup**, each side holds a codec chain — for example AAC at one bitrate on
side A and Opus on side B. Both chains start from your one decoded source. Keep
everything else identical between the sides; if you are comparing codecs, let
the codec be the only variable.

The test plan lives in the sidebar: it fixes the number of scored trials. Pick
the count **before** you start and see the [results
guide](/guides/understanding-your-results/) for how to choose it. Optional
calibration stays off by default; if you enable it, it is a separate ten-second
material check and never counts toward your score.

## 4. Prepare the test

Press **Prepare test**. The app aligns the pair, matches gain, applies a common
peak trim, verifies the exact delivered audio, binds it to the run, and stages
trial 1 **paused**. It never starts playing by itself. If preparation refuses
something, the message names the problem and the fix — nothing falls back to a
shortened or substituted version.

## 5. Listen

In **Listen**, press **Play**. Use the A/B/X selectors to move between the two
references and the unknown sample, and loop a passage if that helps. The
question for every trial is “Is X A or B?” — answer with A or B once you have
settled. Answers activate only when the current trial's audio is fully loaded.

End the run with **End test** if conditions collapse (a delivery truck outside,
a failing cable). That run is sealed as an incomplete record, which is fine —
it is simply not a result.

## 6. Read the evidence

A completed run opens **Evidence**: the plan you committed to, per-trial
answers, the binomial result, the preparation report with the actual cropping
and gains, and the verified hashes of the exact audio you were served. This is
also where you export or download the run record.

The most common first-run lesson: on familiar music, transparent codecs are
hard, differences are often positional or transient, and one completed run is a
data point — not a verdict. Repeat with several files and the pattern becomes
clearer.
