import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvent, verifyChain } from "../chain.js";
import { canonicalize } from "../jcs.js";
import { hashCanonical } from "../hash.js";
import {
  generateEd25519KeyPair,
  keyIdFromPublicPem,
  signData,
  verifyData
} from "../keys.js";
import type { ChainedEvent } from "../types.js";

test("canonicalize sorts keys and is whitespace-free", () => {
  const value = { b: 2, a: { d: [1, 2, { z: true, y: null }], c: "x" } };
  assert.equal(
    canonicalize(value),
    '{"a":{"c":"x","d":[1,2,{"y":null,"z":true}]},"b":2}'
  );
});

test("canonicalize uses ES number serialization", () => {
  assert.equal(canonicalize({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalize({ n: 0.000001 }), '{"n":0.000001}');
  assert.equal(canonicalize({ n: 10 }), '{"n":10}');
  assert.throws(() => canonicalize({ n: Infinity }));
});

test("canonicalize is order-insensitive for equal objects", () => {
  const a = { x: 1, y: [true, "s"] };
  const b = { y: [true, "s"], x: 1 };
  assert.equal(hashCanonical(a), hashCanonical(b));
});

test("ed25519 sign/verify roundtrip and tamper detection", () => {
  const keys = generateEd25519KeyPair();
  const payload = "warrant test payload";
  const sig = signData(keys.privateKeyPem, payload);
  assert.equal(verifyData(keys.publicKeyPem, payload, sig), true);
  assert.equal(verifyData(keys.publicKeyPem, payload + "x", sig), false);
  const other = generateEd25519KeyPair();
  assert.equal(verifyData(other.publicKeyPem, payload, sig), false);
  assert.match(keyIdFromPublicPem(keys.publicKeyPem), /^ed25519:[0-9a-f]{16}$/);
});

test("event chain appends and verifies; tampering breaks it", () => {
  const genesis = hashCanonical({ contract: "fake" });
  const chain: ChainedEvent[] = [];
  appendEvent(chain, { type: "run.created" }, genesis);
  appendEvent(
    chain,
    { type: "policy.evaluated", decision: "allow", reason: "test" },
    genesis
  );
  appendEvent(chain, { type: "run.completed" }, genesis);

  assert.deepEqual(verifyChain(chain, genesis), { ok: true });

  const tampered = structuredClone(chain);
  const second = tampered[1];
  assert.ok(second);
  second.event = {
    type: "policy.evaluated",
    decision: "allow",
    reason: "rewritten history"
  };
  const result = verifyChain(tampered, genesis);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.brokenAtSeq, 1);

  const dropped = chain.slice(1);
  const droppedResult = verifyChain(dropped, genesis);
  assert.equal(droppedResult.ok, false);
});
