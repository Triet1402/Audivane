---
title: Understanding your results
description: Fixed trial counts, guessing rates, binomial evidence, and the difference between a valid run and an audible difference.
order: 3
updated: 2026-11-06
source: docs/methodology.md
---

A completed Audivane run reports answers against the trial count you committed
to, with binomial statistics. This page explains how to read that honestly —
including the parts that are uncomfortable.

## Every trial is a coin flip you might beat

Each trial asks "Is X A or B?", so pure guessing is right about half the time.
That is the baseline every result is measured against. Because the numbers are
small, luck looks impressive fast:

- 7 trials, 7 correct: pure guessing reaches that about **0.8%** of the time.
- 7 trials, at least 6 correct: about **6.3%** of the time.
- 10 trials, at least 8 correct: about **5.5%** of the time.
- 20 trials, at least 15 correct: about **2.1%** of the time.

Audivane reports the actual binomial probability and confidence interval for
*your* run rather than a badge, because the meaning also depends on how the
run was conducted — above all on whether you stopped on purpose, in advance.

## Why the trial count is fixed in advance

The plan locks when the first trial is staged, and exactly that count is
scored. This is the whole defense against self-deception: if you keep going
until you "sound convincing," the coin-flip odds above no longer apply to your
total, because you have effectively chosen the stopping point after seeing the
answers.

This is why an early-ended or sealed run is kept visibly distinct from a
completed one and is not a final result. A sealed run keeps its evidence — you
can see exactly where it stopped — it just can't claim a score. If conditions
collapse, end the run and start a fresh one later.

## Choosing N

Common practice for listener ABX is a small fixed count chosen beforehand —
something like 7 or 10 trials. More trials separate "I think I heard something"
from "I keep beating chance," at the cost of fatigue; pick N while you are
neutral about the outcome, in the [first-test guide](/guides/run-your-first-abx-test/).

## Validity is not audibility

A completed, valid run establishes that *you, on this machine, with this
material, beat chance at the committed count.* Two readings it does not
support:

- **"The codec is worse."** Your result concerns your files, your output chain
  and your hearing. Other hardware, other material and other listeners can
  legitimately get different results. Repeated personal success is stronger
  evidence than any single run.
- **"The preparation failed / succeeded, so the audio is fine / damaged."**
  Preparation gates verify how the test was built. Numerical validity does not
  certify audibility, codec conformance or your physical device chain — those
  are separate checks by design, and the app keeps them separate too.

If a completed run beats chance, the honest summary is: *"Under these
conditions, I could tell the two chains apart at better than chance."* Run it
again with different material before saying anything louder than that — and
try the reverse, too: if you suspect a difference, test the chain against
itself (the same settings on both sides) and confirm the score drops to chance.
