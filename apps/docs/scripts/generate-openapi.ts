/**
 * Generate API reference MDX from the model-fusion OpenAPI contract.
 *
 * The contract is the source of truth (it lives in the protocol package), so the
 * HTTP/service reference is generated rather than hand-written. Run:
 *
 *   pnpm generate:openapi
 *
 * then commit the emitted MDX under content/docs/api.
 */
import { generateFiles } from "fumadocs-openapi";

const SPEC = "../../packages/protocol/openapi/model-fusion-harness-executor.openapi.json";

await generateFiles({
  input: [SPEC],
  output: "./content/docs/api",
  per: "operation"
});

console.log("generated API reference MDX into content/docs/api");
