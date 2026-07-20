import { MatterValidationError } from "./errors.js";

export const MATTER_ITEM_ID_PATTERN = /^itm_[A-Za-z0-9]+$/;

export type MatterEndpointDescriptor =
  | { kind: "me" }
  | { kind: "items_list" }
  | { kind: "item_get"; itemId: string }
  | { kind: "item_annotations"; itemId: string }
  | { kind: "search" }
  | { kind: "tags" };

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export type QueryParams = Record<string, QueryValue>;

const ENDPOINT_CATEGORY: Record<MatterEndpointDescriptor["kind"], string> = {
  me: "me",
  items_list: "items",
  item_get: "item",
  item_annotations: "annotations",
  search: "search",
  tags: "tags"
};

export function endpointCategory(descriptor: MatterEndpointDescriptor): string {
  return ENDPOINT_CATEGORY[descriptor.kind];
}

function assertItemId(itemId: string): void {
  if (!MATTER_ITEM_ID_PATTERN.test(itemId)) {
    throw new MatterValidationError("Matter item IDs must match /^itm_[A-Za-z0-9]+$/.");
  }
}

function pathForEndpoint(descriptor: MatterEndpointDescriptor): string {
  switch (descriptor.kind) {
    case "me":
      return "/me";
    case "items_list":
      return "/items";
    case "item_get":
      assertItemId(descriptor.itemId);
      return `/items/${descriptor.itemId}`;
    case "item_annotations":
      assertItemId(descriptor.itemId);
      return `/items/${descriptor.itemId}/annotations`;
    case "search":
      return "/search";
    case "tags":
      return "/tags";
  }
}

export function buildMatterUrl(
  baseUrl: string,
  descriptor: MatterEndpointDescriptor,
  queryParams: QueryParams = {}
): URL {
  if ("include" in queryParams && queryParams.include === "markdown" && descriptor.kind !== "item_get") {
    throw new MatterValidationError("include=markdown is only allowed on GET /items/{item_id}.");
  }

  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.toString());
  url.pathname = `${basePath}${pathForEndpoint(descriptor)}`;
  url.search = "";
  url.hash = "";

  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) {
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      url.searchParams.append(key, String(entry));
    }
  }

  if (url.host !== base.host) {
    throw new MatterValidationError("Matter requests must use the configured Matter API host.");
  }

  return url;
}
