/**
 * Browser experiment transport.
 *
 * The renderer-facing entry exports the public `ExperimentClient` adapter and
 * the runtime-only `bindPrepared` integration. The runtime service, numerics,
 * assignments, secrets and receipt cache live in the bundled module Worker.
 */
export {
  BrowserExperimentClient,
  createExperimentWorker,
} from "./client.js";
export type {
  BrowserExperimentClientOptions,
  ExperimentWorkerLike,
  PreparedArtifactReaders,
} from "./client.js";
export {
  ExperimentClientError,
  isClientErrorCode,
  isServiceErrorCode,
} from "./errors.js";
export type {
  ExperimentClientErrorCode,
  ExperimentServiceErrorCode,
  ExperimentTransportErrorCode,
} from "./errors.js";
