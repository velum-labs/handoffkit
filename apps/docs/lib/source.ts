import { loader } from "fumadocs-core/source";

import { docs } from "../.source";

// fumadocs-mdx 11.x exposes `files` as a lazy factory (`files: () => [...]`) at
// runtime, while its type (and fumadocs-core 15.x's loader) expects `files` to
// already be an array. Resolve it eagerly so the two pinned majors interoperate,
// then cast back to the original source type to preserve page-data inference
// (so `page.data.body`, `toc`, etc. stay typed). The generated `.source` content
// is available synchronously, so this is a plain call.
const fumaSource = docs.toFumadocsSource();
const files = fumaSource.files as unknown;
const resolvedSource = (
  typeof files === "function" ? { ...fumaSource, files: (files as () => unknown)() } : fumaSource
) as typeof fumaSource;

/** The docs content source, consumed by the docs layout and pages. */
export const source = loader({
  baseUrl: "/docs",
  source: resolvedSource
});
