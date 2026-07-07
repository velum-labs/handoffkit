import type {
  ActorRef,
  ChainedEvent,
  ClaimResult,
  DisclosureReport,
  Policy,
  Receipt,
  ReceiptBundle,
  RunnerSummary,
  RunRequestInput,
  RunStatus,
  RunSummary,
  RunView
} from "@fusionkit/protocol";

export class PlaneClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `plane request failed with status ${status}`;
    super(message);
    this.name = "PlaneClientError";
    this.status = status;
    this.body = body;
  }
}

/** Default transport-retry policy for idempotent requests. */
const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_STEP_MS = 100;

/**
 * Retry idempotent requests on transport-level failures: a keep-alive
 * socket the server closed while idle surfaces as a TypeError from fetch,
 * not as an HTTP error. GETs are idempotent by construction in this API;
 * blob uploads are content-addressed, so retrying them is also safe. Other
 * POSTs (run requests, claims, events, completion) are never retried here.
 */
async function fetchIdempotent(
  url: string,
  init: RequestInit & { idempotent?: boolean },
  attempts = DEFAULT_RETRY_ATTEMPTS
): Promise<Response> {
  const retryable = init.idempotent ?? init.method === "GET";
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!(error instanceof TypeError) || !retryable || attempt >= attempts) {
        throw error;
      }
      // Linear backoff: brief, since this only covers idle-socket races.
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BACKOFF_STEP_MS * attempt)
      );
    }
  }
}

/** Parse a response body as JSON, tolerating empty or non-JSON bodies. */
async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

/** Thin HTTP client over the plane API, shared by the CLI, SDKs, and runner. */
export class PlaneClient {
  readonly baseUrl: string;
  private readonly adminToken?: string;

  constructor(baseUrl: string, adminToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.adminToken = adminToken;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<T> {
    const headers: Record<string, string> = {};
    const auth = token ?? this.adminToken;
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchIdempotent(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw new PlaneClientError(response.status, payload);
    return payload as T;
  }

  enroll(input: {
    enrollToken: string;
    publicKeyPem: string;
    pool: string;
  }): Promise<{ runnerId: string; runnerToken: string }> {
    return this.json("POST", "/v1/runners/enroll", input);
  }

  async putBlob(content: Buffer, token?: string): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream"
    };
    const auth = token ?? this.adminToken;
    if (auth) headers.authorization = `Bearer ${auth}`;
    const response = await fetchIdempotent(`${this.baseUrl}/v1/blobs`, {
      method: "POST",
      headers,
      body: new Uint8Array(content),
      idempotent: true
    });
    const payload = (await response.json()) as { hash?: string; error?: string };
    if (!response.ok || !payload.hash) {
      throw new PlaneClientError(response.status, payload);
    }
    return payload.hash;
  }

  async getBlob(hash: string): Promise<Buffer> {
    const response = await fetchIdempotent(`${this.baseUrl}/v1/blobs/${hash}`, {
      method: "GET"
    });
    if (!response.ok) {
      throw new PlaneClientError(response.status, await response.json());
    }
    return Buffer.from(await response.arrayBuffer());
  }

  requestRun(request: RunRequestInput): Promise<{
    runId: string;
    status: RunStatus;
    consentRequirements: string[];
  }> {
    return this.json("POST", "/v1/runs", { request });
  }

  dryRun(request: RunRequestInput): Promise<DisclosureReport> {
    return this.json("POST", "/v1/runs", { request, dryRun: true });
  }

  approve(runId: string, actor: ActorRef): Promise<{ runId: string; status: RunStatus }> {
    return this.json("POST", `/v1/runs/${runId}/approve`, { actor });
  }

  cancel(runId: string, actor: ActorRef): Promise<{ runId: string; status: RunStatus }> {
    return this.json("POST", `/v1/runs/${runId}/cancel`, { actor });
  }

  getRun(runId: string): Promise<RunView> {
    return this.json("GET", `/v1/runs/${runId}`);
  }

  listRuns(): Promise<{ runs: RunSummary[] }> {
    return this.json("GET", "/v1/runs");
  }

  listRunners(): Promise<{ runners: RunnerSummary[] }> {
    return this.json("GET", "/v1/runners");
  }

  getPolicy(): Promise<{ policy: Policy; policyHash: string }> {
    return this.json("GET", "/v1/policy");
  }

  claim(input: {
    runnerToken: string;
    pool: string;
  }): Promise<ClaimResult | { empty: true }> {
    return this.json("POST", "/v1/claims", input);
  }

  postEvents(
    runId: string,
    claimToken: string,
    events: ChainedEvent[]
  ): Promise<{ ok: boolean }> {
    return this.json("POST", `/v1/runs/${runId}/events`, { claimToken, events });
  }

  complete(
    runId: string,
    claimToken: string,
    receipt: Receipt
  ): Promise<{ receipt: Receipt }> {
    return this.json("POST", `/v1/runs/${runId}/complete`, { claimToken, receipt });
  }

  getBundle(runId: string): Promise<ReceiptBundle> {
    return this.json("GET", this.runBundlePath(runId));
  }

  private runBundlePath(runId: string): string {
    return `/v1/runs/${runId}/bundle`;
  }

  /** Canonical download URL for a run's signed receipt bundle. */
  runBundleUrl(runId: string): string {
    return `${this.baseUrl}${this.runBundlePath(runId)}`;
  }

  /** Canonical control-panel deep link for a run. */
  runUiUrl(runId: string): string {
    return `${this.baseUrl}/ui/#/runs/${runId}`;
  }

  async exportJsonl(since?: string): Promise<string> {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const headers: Record<string, string> = {};
    if (this.adminToken) headers.authorization = `Bearer ${this.adminToken}`;
    const response = await fetchIdempotent(`${this.baseUrl}/v1/export${query}`, {
      method: "GET",
      headers
    });
    if (!response.ok) {
      throw new PlaneClientError(response.status, await response.json());
    }
    return response.text();
  }
}
