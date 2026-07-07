/**
 * Shared brand/model constants used by the launchers and the Cursor bridge, kept
 * in one place so the value is defined once rather than copied per tool package.
 */

import {
  CURSOR_BRIDGE_MODEL_NAME as REGISTRY_CURSOR_BRIDGE_MODEL_NAME,
  DEFAULT_ENSEMBLE_NAME as REGISTRY_DEFAULT_ENSEMBLE_NAME,
  FUSION_PANEL_MODEL as REGISTRY_FUSION_PANEL_MODEL,
  fusionModelId as registryFusionModelId,
  LOCAL_MODEL_LABEL as REGISTRY_LOCAL_MODEL_LABEL
} from "@fusionkit/registry";

/** Provider/model label a tool advertises for the gateway-backed local model. */
export const LOCAL_MODEL_LABEL = REGISTRY_LOCAL_MODEL_LABEL;

/** The model name the Cursor bridge exposes to cursor-agent. */
export const CURSOR_BRIDGE_MODEL_NAME = REGISTRY_CURSOR_BRIDGE_MODEL_NAME;

/** The model label the fusion panel is fronted under. */
export const FUSION_PANEL_MODEL = REGISTRY_FUSION_PANEL_MODEL;

/** The name of the implicit/default ensemble (advertised as `fusion-panel`). */
export const DEFAULT_ENSEMBLE_NAME = REGISTRY_DEFAULT_ENSEMBLE_NAME;

/** The advertised model id for a named ensemble (`fusion-<name>`; default keeps `fusion-panel`). */
export const fusionModelId = registryFusionModelId;
