import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMITMENT_HEX_LENGTH,
  COMMITMENT_PREFIX,
  CommitmentInputError,
  MAX_SEQUENCE_LENGTH,
  MAX_TRIAL_INDEX,
  SECRET_BYTES,
  commitSecret,
  createSecret,
  randomBit,
  secretFromHex,
  secretToHex,
  verifyReveal,
  xSequence,
  xSourceForIndex,
} from "../src/commitment.js";

const RANGE_SECRET = Uint8Array.from({ length: 32 }, (_value, index) => index);
const RANGE_SECRET_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const RANGE_COMMITMENT = "0b4c46b94585ba71112d7d4e7b7b0a6e7e05aa7c0ed7e7a3d2e1becc3a5d06a7";
const RANGE_SEQUENCE =
  "ABAAAABBAAABAAABBBBBBAAAAABABABBBAABAABA";

interface CommitmentVector {
  readonly name: string;
  readonly secretHex: string;
  readonly commitment: string;
  readonly sequence40: string;
  readonly indices: readonly (readonly [number, "A" | "B"])[];
}

const VECTORS: readonly CommitmentVector[] = [
  {
    name: "range-0-31",
    secretHex: RANGE_SECRET_HEX,
    commitment: RANGE_COMMITMENT,
    sequence40: RANGE_SEQUENCE,
    indices: [
      [1, "A"], [2, "B"], [3, "A"], [7, "B"], [8, "B"], [16, "B"],
      [255, "B"], [256, "A"], [65535, "B"], [4294967297, "B"],
      [9007199254740991, "B"],
    ],
  },
  {
    name: "all-zero",
    secretHex: "00".repeat(32),
    commitment: "56d5de7ccd0b01ab3a7c33cb906c5e0440387233de8ed54c8d31a17ebf10e876",
    sequence40: "ABABBBABAAABBBAABBBABBBAAAAABBBBAABBBABB",
    indices: [
      [1, "A"], [2, "B"], [3, "A"], [7, "A"], [8, "B"], [16, "A"],
      [255, "A"], [256, "B"], [65535, "B"], [4294967297, "A"],
      [9007199254740991, "A"],
    ],
  },
  {
    name: "all-ff",
    secretHex: "ff".repeat(32),
    commitment: "5b75a0433aec7842d1a1eb3bb40652337a35570c7c9300f22a01a7599df96338",
    sequence40: "BBABBABBABBAABAAAAABBABABBABBBBBAABBAAAA",
    indices: [
      [1, "B"], [2, "B"], [3, "A"], [7, "B"], [8, "B"], [16, "A"],
      [255, "A"], [256, "B"], [65535, "B"], [4294967297, "A"],
      [9007199254740991, "B"],
    ],
  },
  {
    name: "sha256-fixture-b",
    secretHex: "7e8a9b5f8a9821eaed0f80fa4ae1766b33e163ae6b13b7c7973799ae5ae0ec0f",
    commitment: "3a8e2b81bd7b6881429f87e47cd01b24c78711989ba3251d545a70af1fbcc536",
    sequence40: "BABABBABBAAABABAAABAAAAABABBABABBABBAAAB",
    indices: [
      [1, "B"], [2, "A"], [3, "B"], [7, "A"], [8, "B"], [16, "A"],
      [255, "B"], [256, "A"], [65535, "A"], [4294967297, "B"],
      [9007199254740991, "B"],
    ],
  },
];

function labels(text: string): ("A" | "B")[] {
  return [...text] as ("A" | "B")[];
}

test("Node exposes global WebCrypto for the production primitives", () => {
  assert.ok(globalThis.crypto);
  assert.ok(globalThis.crypto.subtle);
  assert.equal(typeof globalThis.crypto.subtle.digest, "function");
  assert.equal(typeof globalThis.crypto.getRandomValues, "function");
  assert.equal(SECRET_BYTES, 32);
  assert.equal(COMMITMENT_HEX_LENGTH, 64);
  assert.deepEqual([...COMMITMENT_PREFIX], [0x41, 0x42, 0x58, 0x31, 0x00]);
});

test("exported commitment prefix cannot be changed by callers", async () => {
  assert.equal(Object.isFrozen(COMMITMENT_PREFIX), true);
  assert.throws(() => {
    (COMMITMENT_PREFIX as unknown as number[])[0] = 0;
  }, TypeError);
  assert.equal(await commitSecret(RANGE_SECRET), RANGE_COMMITMENT);
});

test("commitment and sequence match a known deterministic vector", async () => {
  assert.equal(secretToHex(RANGE_SECRET), RANGE_SECRET_HEX);
  assert.equal(await commitSecret(RANGE_SECRET), RANGE_COMMITMENT);
  const sequence = await xSequence(RANGE_SECRET, 40);
  assert.equal(sequence.join(""), RANGE_SEQUENCE);
  assert.equal(sequence.length, 40);
  assert.ok(sequence.every((label) => label === "A" || label === "B"));
  assert.equal(await xSourceForIndex(RANGE_SECRET, 1), "A");
  assert.equal(await xSourceForIndex(RANGE_SECRET, 2), "B");
});

test("all deterministic vectors agree, including large indices", async () => {
  for (const vector of VECTORS) {
    const secret = secretFromHex(vector.secretHex);
    assert.equal(secret.length, 32);
    assert.equal(await commitSecret(secret), vector.commitment);
    assert.deepEqual(await xSequence(secret, 40), labels(vector.sequence40));
    for (const [index, assignment] of vector.indices) {
      assert.equal(
        await xSourceForIndex(secret, index),
        assignment,
        `${vector.name} index ${index} byte order mismatch`,
      );
    }
  }
});

test("verification requires both the commitment and the sequence", async () => {
  for (const vector of VECTORS) {
    assert.equal(
      await verifyReveal(vector.secretHex, vector.commitment, labels(vector.sequence40)),
      true,
    );
  }

  const expected = await xSequence(RANGE_SECRET, 8);
  assert.equal(await verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, expected), true);

  const tamperedSequence = expected.slice();
  tamperedSequence[3] = tamperedSequence[3] === "A" ? "B" : "A";
  assert.equal(
    await verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, tamperedSequence),
    false,
  );

  const tamperedCommitment = `${RANGE_COMMITMENT.slice(0, -1)}${
    RANGE_COMMITMENT.endsWith("0") ? "1" : "0"
  }`;
  assert.equal(
    await verifyReveal(RANGE_SECRET_HEX, tamperedCommitment, expected),
    false,
  );
  assert.equal(
    await verifyReveal("00".repeat(32), RANGE_COMMITMENT, expected),
    false,
  );
});

test("verification rejects a tampered sequence even when the commitment matches", async () => {
  const expected = labels(RANGE_SEQUENCE);
  expected[12] = expected[12] === "A" ? "B" : "A";
  assert.equal(
    await verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, expected),
    false,
  );
});

test("empty reveal can verify the commitment without a sequence", async () => {
  assert.deepEqual(await xSequence(RANGE_SECRET, 0), []);
  assert.equal(await verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, []), true);
});

test("secret helpers round-trip and copy caller bytes", () => {
  const secret = secretFromHex(RANGE_SECRET_HEX.toUpperCase());
  assert.equal(secretToHex(secret), RANGE_SECRET_HEX);
  secret.fill(0);
  assert.equal(secretToHex(RANGE_SECRET), RANGE_SECRET_HEX);

  const generated = createSecret();
  assert.equal(generated.length, 32);
  assert.match(secretToHex(generated), /^[0-9a-f]{64}$/);
  assert.notEqual(secretToHex(createSecret()), secretToHex(createSecret()));
});

test("randomBit is cryptographic and roughly fair", () => {
  let ones = 0;
  const draws = 2000;
  for (let i = 0; i < draws; i += 1) {
    const bit = randomBit();
    assert.equal(typeof bit, "boolean");
    if (bit) {
      ones += 1;
    }
  }
  assert.ok(ones / draws > 0.4 && ones / draws < 0.6);
});

test("secret and sequence inputs are snapshotted before awaits", async () => {
  const expectedCommitment = RANGE_COMMITMENT;
  const expectedSequence = await xSequence(RANGE_SECRET, 8);
  const expectedAssignment = await xSourceForIndex(RANGE_SECRET, 7);

  const mutableSecret = new Uint8Array(RANGE_SECRET);
  const commitmentPromise = commitSecret(mutableSecret);
  mutableSecret.fill(0xff);
  assert.equal(await commitmentPromise, expectedCommitment);

  const sequenceSecret = new Uint8Array(RANGE_SECRET);
  const sequencePromise = xSequence(sequenceSecret, 8);
  sequenceSecret.fill(0xff);
  assert.deepEqual(await sequencePromise, expectedSequence);

  const indexSecret = new Uint8Array(RANGE_SECRET);
  const assignmentPromise = xSourceForIndex(indexSecret, 7);
  indexSecret.fill(0xff);
  assert.equal(await assignmentPromise, expectedAssignment);

  const expected = expectedSequence.slice();
  const verificationPromise = verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, expected);
  expected[0] = expected[0] === "A" ? "B" : "A";
  expected.push("A");
  assert.equal(await verificationPromise, true);
});

test("returned sequences are fresh arrays", async () => {
  const first = (await xSequence(RANGE_SECRET, 8)).slice() as ("A" | "B")[];
  const second = await xSequence(RANGE_SECRET, 8);
  first[0] = first[0] === "A" ? "B" : "A";
  assert.deepEqual(await xSequence(RANGE_SECRET, 8), second);
});

test("malformed hex, lengths and indices are rejected", async () => {
  const badSecrets = [
    "",
    "00",
    "00".repeat(31),
    "00".repeat(33),
    "zz".repeat(32),
    ` ${"00".repeat(32)}`,
  ];
  for (const bad of badSecrets) {
    assert.throws(() => secretFromHex(bad), CommitmentInputError);
    await assert.rejects(verifyReveal(bad, RANGE_COMMITMENT, []), CommitmentInputError);
  }
  for (const length of [0, 31, 33]) {
    await assert.rejects(commitSecret(new Uint8Array(length)), CommitmentInputError);
    await assert.rejects(xSequence(new Uint8Array(length), 1), CommitmentInputError);
  }

  const badCommitments = ["", "0".repeat(63), "0".repeat(65), "g".repeat(64)];
  for (const bad of badCommitments) {
    await assert.rejects(verifyReveal(RANGE_SECRET_HEX, bad, []), CommitmentInputError);
  }

  for (const bad of [-1, 0, 1.5, NaN, Infinity, MAX_TRIAL_INDEX + 1]) {
    await assert.rejects(xSourceForIndex(RANGE_SECRET, bad), CommitmentInputError);
  }
  for (const bad of [-1, 1.5, NaN, Infinity, MAX_SEQUENCE_LENGTH + 1]) {
    await assert.rejects(xSequence(RANGE_SECRET, bad), CommitmentInputError);
  }
  await assert.rejects(
    verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, "AB" as unknown as readonly []),
    CommitmentInputError,
  );
  await assert.rejects(
    verifyReveal(RANGE_SECRET_HEX, RANGE_COMMITMENT, ["a"] as unknown as readonly []),
    CommitmentInputError,
  );
  assert.throws(() => secretToHex(new Uint8Array(31)), CommitmentInputError);
  assert.throws(() => secretToHex("00" as unknown as Uint8Array), CommitmentInputError);
});
