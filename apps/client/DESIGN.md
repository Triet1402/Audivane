# Audivane client

## Design contract

Operate mode. The current compact interface is the visual reference. Refactoring
must preserve its layout, copy and behavior. Use the existing charcoal/light
surfaces, blue primary controls, IBM Plex typography and semantic green/red
feedback. Do not add explanatory copy for obvious controls or expose internal
function names, policy identifiers, hashes or raw JSON as ordinary page content.

## Page hierarchy

The application shell contains a top bar and a two-column workspace. The desktop
sidebar holds source, output device, test plan and readiness. The main panel owns
its tabs, current view and Runtime capabilities footer. The footer appears in
Setup, Listen and Evidence and never spans beneath the sidebar.

With footer disclosures closed, the workspace fills the viewport and the main
content scrolls independently. The collapsed footer remains visible. Opening a
footer disclosure lets its content extend the document and use page scrolling;
it must not create a small, separately scrolling footer. The desktop sidebar
stays pinned below the header at viewport height during document scrolling.

At 900px and below, the sidebar becomes a dismissible drawer. Support 320px
without horizontal overflow. Answer buttons stay side by side. Disclosures grow
in normal flow; do not animate layout dimensions or scroll automatically.

### Setup

Two flat codec-chain editors, advanced preparation in a disclosure, and a
left-aligned Prepare test action. Source formats disclosure contains exactly:
“WAV, FLAC, MP3, AAC, M4A, Ogg and Opus.” Output routing details show route facts
without an explanatory paragraph.

### Listen

Trial position, compact progress, playback, timeline, A/B/X selectors, loop
controls and two answer buttons. A reserved inline slot beside the trial heading
shows only Correct or Incorrect in green or red. No selected-label caption,
scored-trial caption, scored counter, previous-audio caption or answer explanation.

Keep controls in place when answering and completing a run. Completed runs keep
the disabled answer controls and append a plain score and per-trial tally below.
No terminal-style result box. Listen offers End test during a run. Export, reset and close live in Evidence.

### Evidence

Lead with the result and prominent Correct, Accuracy, p-value and confidence
interval metrics. Secondary plan and check facts live in Test details. Follow
with run actions and Audio comparison: Side A/B summaries, previews/downloads,
Audio measurements, and Files and diagnostics. Disclosure state survives tab switches.
Download results is the single JSON export and includes diagnostics with the run. Completed runs allow audio previews and WAV downloads while retaining their record.
Detailed provenance, policies,
hashes and diagnostic records belong in the downloadable JSON, not an inline
JSON viewer or repeated report panels. Real errors and failed checks stay visible.

## Behavior and accessibility

Prepare test performs aligned preparation, exact-pair binding and paused staging.
It never autoplays. Reset clears the run and stages trial 1 paused in one command. Readiness remains an explicit opt-in. The first trial selects
X. Between trials, previous audio can continue while no new label is selected;
answers remain disabled until the new trial is ready and selected. Pause stays
available. Do not change audio, scoring, gating or export contracts to simplify UI.

Use semantic headings, native controls, accessible names, visible keyboard focus,
polite feedback announcements and alert roles for actionable failures. Color is
always paired with text. Preserve stable control IDs used by keyboard flows and
integration tests. Respect reduced motion and the existing theme tokens.

## Component ownership

- `App.tsx`: runtime/workflow orchestration and Setup/Listen/Evidence composition.
- `workspace/Sidebar.tsx`: source, device, plan and readiness controls.
- `workspace/OutputDevicePanel.tsx`: device selection and route facts.
- `listening/ListeningSection.tsx`: transport, answers, feedback and completion.
- `listening/RunRecord.tsx`: concise result, metrics and optional test details.
- `listening/RunActions.tsx`: Evidence reset and close controls.
- `evidence/AudioComparison.tsx`: delivered audio summaries, measurements and files.
- `styles.css`: shared tokens, layout, component styles and responsive rules.

Keep component props limited to values actually consumed. Remove styles and
helpers when their final consumer disappears. Use conditional JSX for optional
content; retain null where it represents a real absent artifact, route or session.

## Verification

Tests follow the current interface rather than requiring removed copy or panels.
Check numerical provenance and detailed reports through diagnostics downloads;
check run records through listening exports. Navigation helpers access management
actions through Evidence. Keep coverage for disabled controls, paused staging,
answer feedback, completion layout, sidebar pinning, footer scrolling and mobile
widths. Prefer focused checks for the changed code; do not run broad browser or
audio suites for routine UI cleanup unless requested or needed for a concrete bug.
