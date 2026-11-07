import { BoundaryError, exact } from "./boundary.js";
import { ExperimentServiceError } from "@codec-abx/experiment";
import { PreparationGateRefusalError } from "@codec-abx/preparation-policy";
export const WORKER_VERSION = 1;
export interface RuntimeErrorDTO { readonly code: string; readonly message: string; readonly reasons: readonly string[]; readonly uncertain: boolean }
export class DesktopWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly reasons: readonly string[] = [], readonly uncertain = false) { super(message); }
}
export function publicError(error: unknown, answer = false): RuntimeErrorDTO {
  if (error instanceof PreparationGateRefusalError) return { code: error.code, message: error.message, reasons: [error.classification], uncertain: false };
  if (error instanceof BoundaryError || error instanceof ExperimentServiceError || error instanceof DesktopWorkerError) return { code: error.code, message: error.message, reasons: [...error.reasons], uncertain: error instanceof DesktopWorkerError ? error.uncertain : false };
  if (error instanceof Error && error.name === "AbortError") return { code: "cancelled", message: "Preparation cancelled", reasons: [], uncertain: false };
  return { code: "native-operation-failed", message: "Native operation failed. Check desktop capabilities and FFmpeg/ffprobe/codec-helper availability, then retry explicitly.", reasons: [], uncertain: answer };
}
export function envelope(value: unknown, session: string, fields: readonly string[]): asserts value is Record<string, unknown> {
  exact(value, ["version", "session", "type", ...fields]);
  if (value.version !== WORKER_VERSION || value.session !== session) throw new Error("Invalid private worker envelope");
}
export function errorDTO(value: unknown): asserts value is RuntimeErrorDTO {
  exact(value, ["code", "message", "reasons", "uncertain"]);
  if (typeof value.code !== "string" || value.code.length > 128 || typeof value.message !== "string" || value.message.length > 4096 || !Array.isArray(value.reasons) || value.reasons.some(x => typeof x !== "string") || typeof value.uncertain !== "boolean") throw new Error("Invalid private worker error");
}
