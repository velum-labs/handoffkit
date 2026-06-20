import { createOpenAPI } from "fumadocs-openapi/server";

/**
 * Shared OpenAPI server instance. Generated API reference MDX (under
 * `content/docs/api`) renders through `APIPage`, which reads the model-fusion
 * contract at `packages/protocol/openapi/model-fusion-harness-executor.openapi.json`.
 */
export const openapi = createOpenAPI();
