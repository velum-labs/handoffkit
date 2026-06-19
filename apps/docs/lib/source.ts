import { loader } from "fumadocs-core/source";

import { docs } from "../.source";

/** The docs content source, consumed by the docs layout and pages. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
});
