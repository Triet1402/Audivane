# Codec ABX client design

## Surface

Operate. Audivane is a local audio-comparison workbench used in a browser or
the Electron shell. The screen succeeds when a listener can choose audio,
configure two codec chains, prepare the pair, and run a blinded comparison
without scrolling past setup, artifact reports, or statistics to reach
playback and answers. Technical evidence remains one deliberate view away.

## Direction

A compact charcoal instrument bench with a persistent session sidebar and three
main views: **Setup**, **Listen** and **Evidence**. Screen width belongs to the
current task; the sidebar holds source identity, output route, test plan and the
single readiness-check opt-in. One hairline system and one blue signal carry
hierarchy. The dark theme is a neutral, blue-cast charcoal; the light theme is
its cool-neutral counterpart. Green survives only as small semantic pass ink.
There is no hero, decorative waveform, nested card grid, or explanatory
paragraph used as a section heading.

The primary path is short: choose source and both codecs in **Setup**, run
**Prepare test**, then press **Play** in **Listen**. The primary action applies
aligned preparation, verifies and binds the exact pair, opens Listen
immediately, and stages trial 1 paused. It never starts playback. Calibration
is off by default; when explicitly enabled it remains the unchanged first
`min(10 s, prepared Side A)` material check. Scored trials always use the full
prepared track. Secondary reset, cancel, seal, close and diagnostic actions stay
quiet and do not compete with that path.

## Layout

- Top bar: brand, runtime, local-processing statement, narrow-window
  **Setup & device** toggle, and the theme switcher.
- Persistent sidebar at desktop widths (`280px`, `248px` at intermediate
  widths): source, output device, test plan, readiness check and lock state.
  It stays visible while listening.
- Main area: view tabs and the current view. Views use the available width and
  do not sit in a centred narrow page. Prose is capped by reading measure; data
  and controls are not.
- **Setup** is the chain workspace: flat Side A/B editors side by side with a
  hairline between them, advanced processing in a disclosure, a short readiness
  summary, and a sticky footer with **Prepare test**. Single-stage chains omit
  unusable reorder/remove controls.
- **Listen** is the task surface: trial position and progress, a visible
  **Cancel preparation** action during preparation or **End test** during a run,
  one short state line, Play/Pause, shared timeline, A/B/X selectors, compact
  loop controls, and the question “Is X A or B?” with two answer buttons.
  Delivery rates, hashes, commitments and gate reports do not appear here.
- **Evidence** holds the run record, plan commitment, statistics, preparation
  and delivered-byte reports, validity and canary evidence, diagnostic audio,
  downloads, exports and raw JSON. Diagnostic audio and downloads stay locked
  while a listening session owns the artifact.
- The preparation, verification and first-trial load share one stable stage.
  Transport, label selectors, timeline and answer positions are present
  throughout with the applicable controls disabled. A completed artifact never
  inserts a report into Listen.
- At `900px` the sidebar becomes a drawer with a scrim and Escape dismissal;
  trial progress and End test remain in the main header. Chain editors,
  measurement columns and delivered columns stack. `320px` is supported with no
  horizontal page scrolling; long filenames and IDs wrap.
- Disclosures expand below their existing trigger. Help opens an in-place panel
  without moving the control that opened it. No layout-width animation or
  auto-scroll occurs during state updates.

## Theme and type

The top bar carries a direct **System / Light / Dark** theme selector. System is
the default and follows the operating-system preference; Light and Dark are
explicit local preferences persisted in `localStorage`. There is no Appearance
panel and no zoom instructional copy in the web client. Desktop window zoom is
owned by the Electron shell.

- Light: ground `#f1f2f5`, surface `#ffffff`, raised surface `#e9ebf1`, ink
  `#1a1d24`, muted `#555d6d`, line `#d7dbe3`, control border `#7b8593`, blue
  `#4053c9`, blue hover `#2f41b0`.
- Dark: ground `#1e1f22`, surface `#2b2d31`, raised surface `#313338`, ink
  `#f2f3f5`, muted `#b5bac1`, line `#3f4147`, control border `#7b7f88`, blue
  `#5865f2`, blue hover `#4752c4`, text/focus blue `#8b96ff`.
- `--accent` is the primary fill. `--accent-text` is the readable blue for text,
  links, secondary hover and focus. Muted text meets `4.5:1`; control borders
  clear `3:1`. Pass is small green ink on a neutral fill. Warning and failure
  keep tinted fills with full borders and explicit text.
- Selection, caret colour, scrollbars, range/checkbox accent and the focus ring
  use the same palette. Focus is a `2px` `--accent-text` outline with a `2px`
  offset.

Type remains self-hosted IBM Plex Sans for interface and IBM Plex Mono for
code, hashes, rates and machine policy names. Base UI size is `16px`;
supporting copy is `12–14px`; headings use a tight product scale. Numeric
status, timing, hashes and table figures use tabular numerals. No runtime font
fetch.

## Flow and state

- **Prepare test** requires source, available codecs, a supported aligned policy
  and a valid plan. It opens Listen before work starts. The header shows
  **Cancel preparation** while preparation, binding or staging are active; the
  stage shows one short status line with an indeterminate progress indicator.
  Cancellation invalidates the run and stages nothing.
- The first trial is staged paused. Play is explicit. The default selected
  label is X for the first trial.
- **End test** stops playback, seals the run, and opens Evidence. A sealed,
  ended or partial run is explicitly not a final result. A completed run keeps
  its final-result qualification and offers **View results**.
- The answer question is always “Is X A or B?”. Answers enable only for the
  fully loaded current token. When a previous trial’s audio is carried while
  the next set loads, the state line reads **Previous trial audio**, no A/B/X is
  selected, and answers stay disabled until the listener explicitly chooses a
  label for the new token. Pause remains available.
- Loop begins as one toggle and reveals the two time fields when enabled; the
  minimum 10 ms interval is validated where it applies.
- Calibration is off by default, excluded from scored N, and uses exactly the
  first `min(10 s, prepared Side A)`. A failed or unavailable calibration stays
  visible with an explicit recovery or disable action; it is never switched off
  silently.
- Mandatory ambiguity, refusal, route-change and session-lock warnings remain
  visible next to the affected control. Method text, provenance tables,
  measurement detail and raw evidence live in disclosures or Evidence.

## Source, devices and scientific truth

- Source copy reads “Up to 30 min · 512 MiB · 32-bit input”. Input accepts WAV,
  FLAC, MP3, AAC, M4A, Ogg and Opus. Decoded channels and source rates remain
  explicit; final listening delivery remains canonical PCM16 WAV at the selected
  session rate. Runtime limits and decoder truth are reported by capabilities and
  actionable errors; no upload or fallback is implied.
- Output selection is always in the sidebar. The current route reads **System
  default output** rather than “none”. Enumeration, permission gestures and
  route locking are owned by the playback/controller layer. A selection is
  explicit, never auto-resumed, and any route change after the plan locks
  pauses playback and blocks continuation until Reset.
- The UI may default to aligned preparation, but the engine API keeps its raw
  diagnostic default. No comparison threshold, scoring rule, alignment/crop
  policy, quantizer or listener lock changes. Prepare test performs aligned
  preparation, exact-pair binding and paused first-trial staging as one explicit
  action; it never prepares, binds or starts audio silently.
- All gate failures, preparation refusals, validation ambiguity, listening
  refusals and session-lock warnings stay outside closed disclosures. Historical
  v1 evidence remains labelled and cannot authorize scoring. No UI copy claims
  audibility, conformance, tamper-proof custody or a final verdict before the
  gates and completed N justify it.

## Accessibility and state coverage

- Stable IDs and accessible names are preserved: `#source-file`, `#codec-a`,
  `#bitrate-a`, `#rate-mode`, `#preparation-policy`, `#canary-enabled`,
  `#capabilities-heading`, Side A/B stage labels, plan field labels, the shared
  timeline, playback label selectors and answer buttons.
- Native `button`, `input`, `select`, `details`/`summary`, `fieldset` and
  `progress` elements are used throughout. Status lines use `role="status"`;
  actionable errors use `role="alert"`. State is never carried by colour alone.
- Keyboard order follows reading order. The drawer is dismissible with Escape
  and its scrim; disclosures are keyboard reachable; focus stays visible.
  Loading, idle, preparing, cancelling, cancelled, complete, failed, empty,
  disabled, listening-locked, listening-refused, calibration-blocked and
  terminal states retain their actionable messages.
- Muted text meets `4.5:1`, control borders meet `3:1`, and the layout remains
  usable at `320px`. The stable stage has a minimum height that grows with
  content and never clips transport controls.
- Motion is limited to short colour, border and drawer transitions, enabled only
  under `prefers-reduced-motion: no-preference`. State changes, not the
  continuously changing playback clock, are announced.

## Files

- `src/App.tsx` — workspace shell, Setup and Evidence composition, handlers.
- `src/workspace/Sidebar.tsx` — source, output route, plan and readiness sidebar.
- `src/workspace/OutputDevicePanel.tsx` — compact route control and routing detail.
- `src/workspace/ThemeSwitcher.tsx` — persisted System/Light/Dark preference.
- `src/listening/ListeningSection.tsx` — Listen view, stable stage and transport.
- `src/listening/RunRecord.tsx` — plan, statistics, gates and playback evidence.
- `src/listening/RunActions.tsx` — export, seal, reset and close actions.
- `src/styles.css` — tokens, shell, views, controls, responsive and forced-colour rules.
- `src/assets/fonts/` — self-hosted IBM Plex WOFF2 files.
- `public/ibm-plex-OFL.txt` — font licence copied into browser/desktop builds.
- `DESIGN.md` — this document.

## Verification

Use the existing browser launcher for responsive dark/light checks at 320px and
wide desktop sizes, stable stage positions through preparation and first-trial
load, answer transitions, disclosures, keyboard-only operation, cancellation,
ending, reset/seal/export and locks. Check both themes against the shared tokens
without changing audio policy or codec coverage. Rendered checks do not
establish physical playback, audibility or codec conformance; those need the
separate listening-device acceptance record.
