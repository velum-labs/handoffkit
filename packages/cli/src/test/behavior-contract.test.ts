/**
 * Meta-contract: the expected-behavior inventory is executable, not prose
 * that can silently drift. Every required behavior must point to an existing
 * test file containing its declared source anchor; every gated behavior must
 * name the gate and a runnable command. Door/tool axes must equal the live
 * registries.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DOOR_PROFILES, repoRoot } from "@fusionkit/testkit";

import { toolRegistry } from "../tools.js";

type RequiredBehavior = {
  id: string;
  category: string;
  expectation: string;
  status: "required";
  testFile: string;
  anchor: string;
};

type GatedBehavior = {
  id: string;
  category: string;
  expectation: string;
  status: "environment-gated";
  gateReason: string;
  liveCommand: string;
};

type BehaviorContract = {
  version: string;
  axes: {
    providers: string[];
    doors: string[];
    tools: string[];
    fusionModes: string[];
    panelDepths: string[];
  };
  behaviors: Array<RequiredBehavior | GatedBehavior>;
};

function contract(): BehaviorContract {
  const path = join(repoRoot(), "spec", "testing", "expected-behaviors.json");
  return JSON.parse(readFileSync(path, "utf8")) as BehaviorContract;
}

test("expected behavior ids are unique and every product category is represented", () => {
  const value = contract();
  assert.equal(value.version, "fusionkit.expected-behaviors.v1");
  const ids = value.behaviors.map((behavior) => behavior.id);
  assert.equal(new Set(ids).size, ids.length, "behavior ids must be globally unique");
  const categories = new Set(value.behaviors.map((behavior) => behavior.category));
  for (const category of [
    "model-exposure",
    "request-fidelity",
    "fusion",
    "reasoning",
    "streaming",
    "tools",
    "harness",
    "policy",
    "security",
    "sessions",
    "lifecycle",
    "runs",
    "process",
    "cli",
    "observability",
    "platform"
  ]) {
    assert.ok(categories.has(category), `missing expected behavior category ${category}`);
  }
});

test("every required behavior maps to a real anchored test", () => {
  const required = contract().behaviors.filter(
    (behavior): behavior is RequiredBehavior => behavior.status === "required"
  );
  assert.ok(required.length >= 45, "the contract must remain comprehensive");
  for (const behavior of required) {
    assert.ok(behavior.expectation.length >= 20, `${behavior.id} expectation is underspecified`);
    const path = join(repoRoot(), behavior.testFile);
    assert.ok(existsSync(path), `${behavior.id} references missing test file ${behavior.testFile}`);
    const source = readFileSync(path, "utf8");
    assert.ok(
      source.includes(behavior.anchor),
      `${behavior.id} anchor ${JSON.stringify(behavior.anchor)} is absent from ${behavior.testFile}`
    );
  }
});

test("every environment-gated behavior names why and how to run it", () => {
  const gated = contract().behaviors.filter(
    (behavior): behavior is GatedBehavior => behavior.status === "environment-gated"
  );
  assert.ok(gated.length > 0);
  for (const behavior of gated) {
    assert.ok(behavior.gateReason.length >= 20, `${behavior.id} needs a concrete gate reason`);
    assert.ok(behavior.liveCommand.length > 0, `${behavior.id} needs a live command`);
  }
});

test("door and tool axes equal the live registries (new surfaces cannot miss the matrix)", () => {
  const axes = contract().axes;
  assert.deepEqual(
    [...axes.doors].sort(),
    DOOR_PROFILES.map((door) => door.id).sort()
  );
  assert.deepEqual(
    [...axes.tools].sort(),
    toolRegistry.list().map((tool) => tool.id).sort()
  );
  assert.deepEqual([...axes.fusionModes].sort(), ["heuristic", "panel", "self", "single"]);
  assert.deepEqual([...axes.panelDepths].sort(), ["finite-k", "k=1", "unbounded"]);
});
