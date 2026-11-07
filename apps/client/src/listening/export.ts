import type {
  ExperimentExport,
  PlaybackSnapshot,
  PreparedArtifact,
} from "@codec-abx/contracts";
import { GAIN_RAMP_SECONDS, LIVE_SCHEDULE_LEAD_SECONDS, MIN_LOOP_SECONDS } from "@codec-abx/playback";

import { producerAmbiguityDisclosures } from "../diagnostics.js";

export const LISTENING_EXPORT_SCHEMA = "codec-abx-browser-listening-v1" as const;

export interface ListeningExportInput {
  readonly artifact: PreparedArtifact;
  readonly experiment: ExperimentExport;
  readonly playback: PlaybackSnapshot | null;
  readonly exportedAt: string;
}

export interface ListeningExport {
  readonly schema: typeof LISTENING_EXPORT_SCHEMA;
  readonly exportedAt: string;
  readonly listening: Readonly<Record<string, unknown>>;
  readonly experiment: ExperimentExport;
  readonly prepared: Readonly<Record<string, unknown>>;
  readonly playback: Readonly<Record<string, unknown>>;
  readonly limitations: readonly string[];
}

const OUTPUT_LIMITATIONS = Object.freeze([
  "Output-device ids and labels are not exported by default; only support, request, applied, observed and change facts are recorded.",
  "Observed routing is browser-reported AudioContext.sinkId state, not independent verification of the physical output path.",
  "Device selection does not establish exclusive or bit-perfect output, physical channel wiring, OS/Bluetooth processing or human audibility.",
  "The default output remains usable when selection is unsupported or the browser restricts the device list.",
]);

const PLAYBACK_LIMITATIONS = Object.freeze([
  "Web Audio may resample to the actual output device rate; the delivered WAV rate and actual AudioContext output rate are recorded separately.",
  "Output is not promised to be exclusive, bit-perfect, gapless or free of OS/Bluetooth device re-encoding.",
  `Selection transitions use ${GAIN_RAMP_SECONDS * 1000} ms linear complementary gain ramps. This does not prove every transition is inaudible.`,
  "The source itself can have a loop-seam discontinuity; the player does not crossfade the loop seam.",
  "A correct listener answer records an accepted response, not proof that attention was paid or that the listener is qualified.",
  "Local custody is not tamper-proof; the experiment runtime keeps assignments out of React state, not out of a determined local user.",
]);

/**
 * Versioned wrapper around the service export. It keeps the diagnostic prepared
 * artifact's purpose separate from the actual listening run and records both
 * requested and delivered playback facts.
 */
export function buildListeningExport(input: ListeningExportInput): ListeningExport {
  const { artifact, experiment, playback, exportedAt } = input;
  const snapshot = experiment.snapshot;
  const tracks = {
    a: {
      stages: artifact.a.stages ?? null,
      stageCount: artifact.a.stages?.length ?? 1,
      perStageFallback: artifact.a.stages === undefined,
      requestedCodecId: artifact.a.requested.codecId,
      requestedBitrateKbps: artifact.a.requested.bitrateKbps,
      encoder: artifact.a.encoder,
      decoder: artifact.a.decoder,
      actualBitrateKbps: artifact.a.actualBitrateKbps,
      encodedSampleRate: artifact.a.encodedSampleRate,
      delivered: artifact.a.delivered,
    },
    b: {
      stages: artifact.b.stages ?? null,
      stageCount: artifact.b.stages?.length ?? 1,
      perStageFallback: artifact.b.stages === undefined,
      requestedCodecId: artifact.b.requested.codecId,
      requestedBitrateKbps: artifact.b.requested.bitrateKbps,
      encoder: artifact.b.encoder,
      decoder: artifact.b.decoder,
      actualBitrateKbps: artifact.b.actualBitrateKbps,
      encodedSampleRate: artifact.b.encodedSampleRate,
      delivered: artifact.b.delivered,
    },
  };
  const canaryAudio = artifact.canary?.audio ?? null;
  const desktop = artifact.engine.location === "desktop-native";
  const playbackPolicy = {
    adapter: "BrowserTrialPlayer",
    selectionTransition: {
      shape: "linear-complementary",
      durationSeconds: GAIN_RAMP_SECONDS,
    },
    startPauseSeekTransitionSeconds: GAIN_RAMP_SECONDS,
    liveSchedulingLeadSeconds: LIVE_SCHEDULE_LEAD_SECONDS,
    sharedTimeline: true,
    sharedLoopControls: true,
    minimumLoopSeconds: MIN_LOOP_SECONDS,
    firstTrialStartsPaused: true,
    noAutoplayFlags: true,
    htmlAudioUsedForScoredPlayback: false,
    deliveredSampleRates: {
      a: artifact.a.delivered.sampleRate,
      b: artifact.b.delivered.sampleRate,
      canaryPristine: canaryAudio?.pristine.sampleRate ?? null,
      canaryDegraded: canaryAudio?.degraded.sampleRate ?? null,
    },
    actualOutputSampleRate: playback?.outputSampleRate ?? null,
    deliveredChannels: playback?.channels ?? null,
    outputChannels: null,
    outputSelection: {
      support: playback?.output?.support ?? "unavailable",
      chooserAvailable: playback?.output?.canRequest ?? false,
      deviceEntriesExposedToLocalUi: playback?.output?.devices.length ?? 0,
      deviceIdsOrLabelsExported: false,
      selectionRequested: playback?.output?.requestedDeviceId !== null &&
        playback?.output?.requestedDeviceId !== undefined,
      selectionApplied: playback?.output?.selectedDeviceId !== null &&
        playback?.output?.selectedDeviceId !== undefined,
      selectionObserved: playback?.output?.observedDeviceId !== null &&
        playback?.output?.observedDeviceId !== undefined,
      observedRoute: playback?.output === undefined || playback.output.observedDeviceId === null
        ? "unknown"
        : playback.output.observedDeviceId === ""
          ? "default"
          : "named",
      routeChange: playback?.output?.change ?? "none",
      pendingOperation: playback?.output?.pending ?? null,
      error: playback?.output?.error ?? null,
      actualContextSampleRate: playback?.outputSampleRate ?? null,
    },
    limitations: [...PLAYBACK_LIMITATIONS, ...OUTPUT_LIMITATIONS],
  };

  return {
    schema: LISTENING_EXPORT_SCHEMA,
    exportedAt,
    listening: {
      authority: snapshot.authority,
      lifecycle: snapshot.lifecycle,
      plan: snapshot.plan,
      lockedAtUtc: snapshot.lockedAtUtc,
      commitment: snapshot.commitment,
      calibrationExcludedFromScoredN: true,
      stopAtPlannedN: true,
      preparationValidity: {
        status: snapshot.gates.preparationStatus,
        classification: snapshot.gates.preparationClassification,
        reason: snapshot.gates.preparationReason,
        disclosure: snapshot.gates.preparationDisclosure,
        producerAmbiguityDisclosures: producerAmbiguityDisclosures(artifact.disclosures),
      },
      finalVerdict: snapshot.statistics.significantVerdict,
      provisionalStatisticsAreNotAVerdict: true,
      sealIsNotAFinalResult: snapshot.lifecycle === "sealed",
      humanValidation: "not performed",
      runtime: {
        preparation: desktop ? "desktop-native" : "browser-local",
        experiment: desktop ? "electron-main" : "browser-module-worker",
        playback: "shared-webaudio",
        outputChannels: "unknown",
      },
      localCustody: desktop
        ? "desktop-native local-self-test; the Electron main process’s private worker owns the experiment service but is not tamper-proof custody"
        : "browser-local local-self-test; the dedicated module Worker is not tamper-proof custody",
      claims: {
        hearingValidated: false,
        audibilityProven: false,
        listenerQualified: false,
        remoteCustody: false,
      },
    },
    experiment,
    prepared: {
      artifactId: artifact.id,
      purpose: artifact.purpose,
      sourceSha256: artifact.sourceSha256,
      elapsedMs: artifact.elapsedMs,
      engine: {
        engineId: artifact.engine.engineId,
        build: artifact.engine.build,
        location: artifact.engine.location,
        preparationPolicy: artifact.engine.preparationPolicy,
        supportedPreparationPolicies:
          artifact.engine.supportedPreparationPolicies ?? null,
        limitations: artifact.engine.limitations,
      },
      request: artifact.request,
      measurementPolicy: artifact.measurements.policy,
      preparation: artifact.preparation ?? null,
      validity: artifact.validity ?? null,
      preparationGate: artifact.validity?.policy === "delivered-validity-v2"
        ? artifact.validity.preparationGate
        : null,
      canary: artifact.canary
        ? {
            report: artifact.canary.report,
            retainedAudio: canaryAudio !== null,
            audio: canaryAudio,
          }
        : null,
      deliveredMeasurements: artifact.measurements.delivered ?? null,
      tracks,
      disclosures: artifact.disclosures,
      caveat:
        "The prepared artifact remains purpose diagnostic-only. Its preparation measurements and no-run diagnostic flags are not listening/qualification facts.",
    },
    playback: playbackPolicy,
    limitations: [
      ...snapshot.limitations,
      ...PLAYBACK_LIMITATIONS,
      ...OUTPUT_LIMITATIONS,
      "This export is not a certification, a proof of human hearing, or a substitute for an independently administered subjective test.",
    ],
  };
}
