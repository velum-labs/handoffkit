import { createFromSource } from "fumadocs-core/search/server";

import { source } from "../../../lib/source";

/** Static, offline search index built from the docs source. */
export const { GET } = createFromSource(source);
