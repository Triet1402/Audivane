# Codec ABX testing

Terms used to describe comparisons, preparation, and listening runs.

## Language

**ABX run**:
One execution of a pre-registered comparison in which the listener identifies
whether X matches A or B, ending at its planned count or an explicit early seal.

**Prepare test**:
The explicit command that prepares or reuses a pair for the captured source,
chains, rate policy and readiness choice, then binds it to the exact prepared
bytes and stages trial 1 paused.
_Avoid_: Quick start, auto-run, when either implies playback or staging without
an explicit command.

**Preparation reuse**:
Binding retained prepared material for the same captured inputs instead of
encoding it again. A source, chain, rate or readiness change ends reuse, and
material retained only for cleanup never authorizes listening.
_Avoid_: Cache hit, when it implies retained bytes are automatically safe to play.

**Exact-byte bind**:
The run-authority step that associates a prepared pair with verified delivered
bytes and evidence. Trial authorization remains subject to the run's gates.
_Avoid_: Artifact approval, upload check; neither implies byte identity.

**Pipeline stage**:
One encode/decode round trip, or an explicit passthrough, within one side's
preparation chain.

**Prepared pair**:
The two delivered tracks after configured processing, alignment, level matching,
and validation, ready for audition in an ABX run.

**Processing engine**:
The environment that prepares a pair: desktop native, browser local, or optional
server processing. Engines are alternative locations for the work.
_Avoid_: Tier, when it implies passing through all three engines in sequence.

**Engine capability**:
A tested operation or input constraint supported by a particular processing
engine, including its actual codecs and supported audio configurations.

**Run authority**:
The party or environment responsible for holding unrevealed assignments and
accepting answers, distinct from where the audio was prepared.

**Canary**:
A deliberately easy calibration comparison that checks the listener/playback
chain and is excluded from the planned scored-trial count.

**Null gate**:
A validity check requiring a pair expected to be identical to have sufficiently
small measured residual energy before scored listening is permitted.

**Preparation validity gate**:
A check that the two prepared tracks have enough related signal to support
the declared alignment. A pass can disclose an ambiguous delay; it does not
establish audibility or replace listener calibration.
