export type MatterRateCategory = "read" | "search" | "markdown";

export interface MatterClientConfig {
  apiToken: string;
  baseUrl: string;
  userAgent: string;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface ListTagsParams {
  limit?: number;
  cursor?: string;
}

export interface ListItemsParams {
  statuses?: string[];
  contentTypes?: string[];
  tagIds?: string[];
  isFavorite?: boolean | null;
  updatedSince?: string | null;
  order?: "updated" | "library_position" | "inbox_position";
  limit?: number;
  cursor?: string;
}

export interface GetItemOptions {
  includeMarkdown?: boolean;
}

export interface ListAnnotationsParams {
  limit?: number;
  cursor?: string;
}

export interface SearchParams {
  query: string;
  statuses?: string[];
  limit?: number;
  cursor?: string;
}
