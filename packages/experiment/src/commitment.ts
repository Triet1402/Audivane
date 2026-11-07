/**
 * Commit-reveal primitives for ABX trial assignments.
 *
 * Wire format:
 *   commitment(secret)  = hex(SHA256("ABX1" || 0x00 || secret))
 *   x(i)                = "A" if low bit of SHA256(secret || uint64BE(i)) is 0
 *                         "B" otherwise, with i starting at 1.
 *
 * Only WebCrypto (`globalThis.crypto.subtle` and `getRandomValues`) is used;
 * there is deliberately no production import of Node's `crypto` module.
 *
 * Verification requires the caller to supply the published commitment *and*
 * the revealed sequence, and both must match.
 *
 * All external byte inputs are copied synchronously before the first `await`,
 * so a caller mutating its buffer afterwards cannot change the digest input.
 */
import type { DisplayAnswer } from "@codec-abx/contracts";

export const SECRET_BYTES = 32;
export const COMMITMENT_PREFIX = Object.freeze([0x41, 0x42, 0x58, 0x31, 0x00] as const); // "ABX1\0"
export const COMMITMENT_HEX_LENGTH = 64;
/**
 * Declared index bound. JavaScript safe integers fit in the unsigned 64-bit
 * big-endian encoding used by the reference format.
 */
export const MAX_TRIAL_INDEX = Number.MAX_SAFE_INTEGER;
/** Bound on sequence materialization so verification cannot be used as a CPU sink. */
export const MAX_SEQUENCE_LENGTH = 10_000;

export class CommitmentInputError extends RangeError {
  readonly code = "invalid-commitment-input";

  constructor(message: string) {
    super(message);
    this.name = "CommitmentInputError";
  }
}

function webCrypto(): Crypto {
  const available = globalThis.crypto;
  if (!available || !available.subtle) {
    throw new CommitmentInputError("WebCrypto is not available in this runtime");
  }
  return available;
}

function copySecret(secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array)) {
    throw new CommitmentInputError("secret must be a Uint8Array");
  }
  if (secret.byteLength !== SECRET_BYTES) {
    throw new CommitmentInputError(`secret must be exactly ${SECRET_BYTES} bytes`);
  }
  return new Uint8Array(secret);
}

function requireSequenceLength(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CommitmentInputError("sequence length must be a finite integer");
  }
  if (n < 0 || n > MAX_SEQUENCE_LENGTH) {
    throw new CommitmentInputError(
      `sequence length must be in [0, ${MAX_SEQUENCE_LENGTH}]`,
    );
  }
  return n;
}

function requireTrialIndex(index: number): number {
  if (typeof index !== "number" || !Number.isFinite(index) || !Number.isInteger(index)) {
    throw new CommitmentInputError("trial index must be a finite integer");
  }
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TRIAL_INDEX) {
    throw new CommitmentInputError(
      `trial index must be a safe integer in [1, ${MAX_TRIAL_INDEX}]`,
    );
  }
  return index;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

function requireHex(value: string, name: string, bytes: number): string {
  if (typeof value !== "string") {
    throw new CommitmentInputError(`${name} must be a hex string`);
  }
  const expectedLength = bytes * 2;
  if (value.length !== expectedLength) {
    throw new CommitmentInputError(`${name} must be ${expectedLength} hex characters`);
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new CommitmentInputError(`${name} must contain only hexadecimal characters`);
  }
  return value.toLowerCase();
}

function hexToBytes(value: string, name: string, bytes: number): Uint8Array {
  const normalized = requireHex(value, name, bytes);
  const output = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) {
    output[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return output;
}

function writeUint64BE(target: Uint8Array, offset: number, value: number): void {
  let remaining = BigInt(value);
  for (let byte = 7; byte >= 0; byte -= 1) {
    target[offset + byte] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // A fresh Uint8Array owns an ArrayBuffer (never SharedArrayBuffer), which is
  // the BufferSource shape WebCrypto's DOM typing requires.
  const input = new Uint8Array(data);
  const digest = await webCrypto().subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

/** Generate a new 32-byte secret using the runtime's cryptographic RNG. */
export function createSecret(): Uint8Array {
  const secret = new Uint8Array(SECRET_BYTES);
  webCrypto().getRandomValues(secret);
  return secret;
}

/** Cryptographic fair coin for an independent display-label swap decision. */
export function randomBit(): boolean {
  const byte = new Uint8Array(1);
  webCrypto().getRandomValues(byte);
  return ((byte[0] as number) & 1) === 1;
}

/** Lowercase hex encoding of a 32-byte secret. */
export function secretToHex(secret: Uint8Array): string {
  return bytesToHex(copySecret(secret));
}

/** Parse a 32-byte secret from hex; also accepts uppercase hex. */
export function secretFromHex(hex: string): Uint8Array {
  return hexToBytes(hex, "secret", SECRET_BYTES);
}

/** SHA256("ABX1" + NUL + secret), lowercase hex. */
export async function commitSecret(secret: Uint8Array): Promise<string> {
  const snapshot = copySecret(secret);
  const message = new Uint8Array(COMMITMENT_PREFIX.length + SECRET_BYTES);
  message.set(COMMITMENT_PREFIX, 0);
  message.set(snapshot, COMMITMENT_PREFIX.length);
  return bytesToHex(await sha256(message));
}

/** Deterministic X assignment for one 1-based trial index. */
export async function xSourceForIndex(
  secret: Uint8Array,
  index: number,
): Promise<DisplayAnswer> {
  const snapshot = copySecret(secret);
  const trialIndex = requireTrialIndex(index);
  const message = new Uint8Array(SECRET_BYTES + 8);
  message.set(snapshot, 0);
  writeUint64BE(message, SECRET_BYTES, trialIndex);
  const digest = await sha256(message);
  return ((digest[0] as number) & 1) === 0 ? "A" : "B";
}

/** X assignments for 1..n, in order. */
export async function xSequence(
  secret: Uint8Array,
  n: number,
): Promise<readonly DisplayAnswer[]> {
  const snapshot = copySecret(secret);
  const length = requireSequenceLength(n);
  const sequence: DisplayAnswer[] = [];
  for (let index = 1; index <= length; index += 1) {
    sequence.push(await xSourceForIndex(snapshot, index));
  }
  return sequence;
}

/**
 * Verify a reveal against BOTH the supplied commitment and the supplied
 * sequence. Returns false for a well-formed mismatch; throws for malformed
 * hex, wrong lengths, illegal indices, or lowercase/invalid sequence labels.
 */
export async function verifyReveal(
  secretHex: string,
  commitmentHex: string,
  expectedSequence: readonly DisplayAnswer[],
): Promise<boolean> {
  // Snapshot and validate every externally owned input before the first await.
  const secret = hexToBytes(secretHex, "secret", SECRET_BYTES);
  const suppliedCommitment = requireHex(commitmentHex, "commitment", 32);
  if (!Array.isArray(expectedSequence)) {
    throw new CommitmentInputError("expectedSequence must be an array");
  }
  const snapshotSequence = expectedSequence.slice();
  requireSequenceLength(snapshotSequence.length);
  for (const [index, label] of snapshotSequence.entries()) {
    if (label !== "A" && label !== "B") {
      throw new CommitmentInputError(`expectedSequence[${index}] must be "A" or "B"`);
    }
  }

  const computedCommitment = await commitSecret(secret);
  if (computedCommitment !== suppliedCommitment) {
    return false;
  }
  const computedSequence = await xSequence(secret, snapshotSequence.length);
  return computedSequence.every((label, index) => label === snapshotSequence[index]);
}
