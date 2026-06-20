/**
 * Shared brand/model constants used by the launchers and the Cursor bridge, kept
 * in one place so the value is defined once rather than copied per tool package.
 */

/** Provider/model label a tool advertises for the gateway-backed local model. */
export const LOCAL_MODEL_LABEL = "fusionkit-local";

/** The model name the Cursor bridge exposes to cursor-agent. */
export const CURSOR_BRIDGE_MODEL_NAME = "local-fusion";

/** The model label the fusion panel is fronted under. */
export const FUSION_PANEL_MODEL = "fusion-panel";
