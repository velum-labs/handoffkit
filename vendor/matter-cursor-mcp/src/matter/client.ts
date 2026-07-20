import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import { endpointCategory, buildMatterUrl, type MatterEndpointDescriptor, type QueryParams } from "./endpoints.js";
import {
  MatterAuthenticationError,
  MatterForbiddenError,
  MatterNotFoundError,
  MatterProtocolError,
  MatterRateLimitError,
  MatterTransientError,
  MatterValidationError
} from "./errors.js";
import {
  MatterAccountSchema,
  MatterAnnotationListSchema,
  MatterItemListSchema,
  MatterItemSchema,
  MatterSearchResponseSchema,
  MatterTagListSchema,
  MatterErrorBodySchema,
  type MatterAccount,
  type MatterAnnotation,
  type MatterItem,
  type MatterListResponse,
  type MatterTag
} from "./schemas.js";
import type {
  GetItemOptions,
  ListAnnotationsParams,
  ListItemsParams,
  ListTagsParams,
  MatterClientConfig,
  MatterRateCategory,
  SearchParams
} from "./types.js";
import type { z } from "zod";

export type MatterFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface MatterClientOptions {
  config: MatterClientConfig;
  fetchImpl?: MatterFetch;
  rateLimiter: { acquire(category: MatterRateCategory): Promise<void> };
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class MatterClient {
  private readonly config: MatterClientConfig;
  private readonly fetchImpl: MatterFetch;
  private readonly rateLimiter: { acquire(category: MatterRateCategory): Promise<void> };
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: MatterClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.rateLimiter = options.rateLimiter;
    this.logger = options.logger;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async getMe(): Promise<MatterAccount> {
    return this.request({ kind: "me" }, {}, MatterAccountSchema);
  }

  async listTags(params: ListTagsParams = {}): Promise<MatterListResponse<MatterTag>> {
    return this.request(
      { kind: "tags" },
      {
        limit: params.limit,
        cursor: params.cursor
      },
      MatterTagListSchema
    );
  }

  async listItems(params: ListItemsParams = {}): Promise<MatterListResponse<MatterItem>> {
    return this.request(
      { kind: "items_list" },
      {
        status: params.statuses,
        content_type: params.contentTypes,
        tag_id: params.tagIds,
        is_favorite: params.isFavorite,
        updated_since: params.updatedSince,
        order: params.order,
        limit: params.limit,
        cursor: params.cursor
      },
      MatterItemListSchema
    );
  }

  async getItem(id: string, options: GetItemOptions = {}): Promise<MatterItem> {
    return this.request(
      { kind: "item_get", itemId: id },
      {
        include: options.includeMarkdown ? "markdown" : undefined
      },
      MatterItemSchema
    );
  }

  async listAnnotations(
    itemId: string,
    params: ListAnnotationsParams = {}
  ): Promise<MatterListResponse<MatterAnnotation>> {
    return this.request(
      { kind: "item_annotations", itemId },
      {
        limit: params.limit,
        cursor: params.cursor
      },
      MatterAnnotationListSchema
    );
  }

  async search(params: SearchParams): Promise<MatterListResponse<MatterItem>> {
    const response = await this.request(
      { kind: "search" },
      {
        type: "items",
        query: params.query,
        limit: params.limit,
        cursor: params.cursor
      },
      MatterSearchResponseSchema
    );
    return response.items;
  }

  private async request<T>(
    descriptor: MatterEndpointDescriptor,
    queryParams: QueryParams,
    schema: z.ZodType<T>
  ): Promise<T> {
    const requestId = randomUUID();
    const category = this.rateCategory(descriptor, queryParams);
    const endpoint = endpointCategory(descriptor);
    const url = buildMatterUrl(this.config.baseUrl, descriptor, queryParams);
    let retryCount = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const started = Date.now();
      await this.rateLimiter.acquire(category);

      try {
        const response = await this.fetchWithTimeout(url, requestId);
        const durationMs = Date.now() - started;

        if (response.ok) {
          const data = await response.json();
          const parsed = schema.safeParse(data);
          if (!parsed.success) {
            throw new MatterProtocolError("Matter response did not match the expected schema.", {
              requestId,
              cause: parsed.error
            });
          }

          this.logger.debug({
            request_id: requestId,
            endpoint_category: endpoint,
            http_status: response.status,
            duration_ms: durationMs,
            retry_count: retryCount
          });
          return parsed.data;
        }

        const mapped = await this.mapHttpError(response, requestId);
        this.logger.warn({
          request_id: requestId,
          endpoint_category: endpoint,
          http_status: response.status,
          duration_ms: durationMs,
          retry_count: retryCount,
          error: mapped.message
        });

        if (this.shouldRetryStatus(response.status) && attempt < this.config.maxRetries) {
          retryCount += 1;
          await this.sleep(this.retryDelayMs(response, attempt));
          continue;
        }

        throw mapped;
      } catch (error) {
        if (
          error instanceof MatterAuthenticationError ||
          error instanceof MatterForbiddenError ||
          error instanceof MatterNotFoundError ||
          error instanceof MatterValidationError ||
          error instanceof MatterRateLimitError ||
          error instanceof MatterProtocolError
        ) {
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          retryCount += 1;
          this.logger.warn({
            request_id: requestId,
            endpoint_category: endpoint,
            retry_count: retryCount,
            error: error instanceof Error ? error.message : "Network failure"
          });
          await this.sleep(this.exponentialBackoffMs(attempt));
          continue;
        }

        throw new MatterTransientError("Matter request failed due to a retryable network or timeout error.", {
          requestId,
          cause: error
        });
      }
    }

    throw new MatterTransientError("Matter request failed after retries.", { requestId });
  }

  private async fetchWithTimeout(url: URL, requestId: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
          "User-Agent": this.config.userAgent,
          "X-Request-ID": requestId
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapHttpError(response: Response, requestId: string) {
    const body = await safeReadJson(response);
    const parsed = MatterErrorBodySchema.safeParse(body);
    const matterMessage = parsed.success ? parsed.data.error.message : response.statusText;
    const field = parsed.success && parsed.data.error.field ? ` Field: ${parsed.data.error.field}.` : "";
    const message = matterMessage ? `${matterMessage}${field}` : `Matter API returned HTTP ${response.status}.`;

    switch (response.status) {
      case 400:
      case 409:
      case 422:
        return new MatterValidationError(message, { requestId, status: response.status });
      case 401:
        return new MatterAuthenticationError("Matter token is invalid or revoked.", {
          requestId,
          status: response.status
        });
      case 403:
        return new MatterForbiddenError("Matter Pro is required or access is forbidden.", {
          requestId,
          status: response.status
        });
      case 404:
        return new MatterNotFoundError(message, { requestId, status: response.status });
      case 429:
        return new MatterRateLimitError(message || "Matter API rate limit exceeded.", {
          requestId,
          status: response.status
        });
      case 500:
      case 502:
      case 503:
      case 504:
        return new MatterTransientError(message || "Matter API is temporarily unavailable.", {
          requestId,
          status: response.status
        });
      default:
        return new MatterProtocolError(`Matter API returned unexpected HTTP ${response.status}.`, {
          requestId,
          status: response.status
        });
    }
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private retryDelayMs(response: Response, attempt: number): number {
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const parsed = parseRetryAfterMs(retryAfter);
      if (parsed !== null) {
        return parsed;
      }
    }

    return this.exponentialBackoffMs(attempt);
  }

  private exponentialBackoffMs(attempt: number): number {
    return 250 * 2 ** attempt + Math.floor(this.random() * 100);
  }

  private rateCategory(descriptor: MatterEndpointDescriptor, queryParams: QueryParams): MatterRateCategory {
    if (descriptor.kind === "search") {
      return "search";
    }
    if (descriptor.kind === "item_get" && queryParams.include === "markdown") {
      return "markdown";
    }
    return "read";
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
