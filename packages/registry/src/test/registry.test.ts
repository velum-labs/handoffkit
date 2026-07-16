import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BENCHMARK_PANEL_PRESETS,
  DEFAULT_CLOUD_PANEL_MEMBERS,
  FUSION_PANEL_MODEL,
  FUSION_REGISTRY
} from "../index.js";

test("fusion generated registry contains only fusion-owned data", () => {
  assert.deepEqual(Object.keys(FUSION_REGISTRY), ["fusion"]);
  assert.equal(FUSION_PANEL_MODEL, "fusion-panel");
  assert.ok(DEFAULT_CLOUD_PANEL_MEMBERS.length > 1);
});

test("panel presets reference their judge and synthesizer members", () => {
  for (const preset of Object.values(BENCHMARK_PANEL_PRESETS)) {
    const ids = new Set(preset.members.map((member) => member.id));
    assert.ok(ids.has(preset.judgeId), `${preset.panelId} judgeId must be a member id`);
    assert.ok(ids.has(preset.synthesizerId), `${preset.panelId} synthesizerId must be a member id`);
  }
});
