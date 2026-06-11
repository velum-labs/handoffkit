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
} from "@warrant/protocol";

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

/**
 * Retry GETs (idempotent by construction in this API) on transport-level
 * failures: a keep-alive socket the server closed while idle surfaces as a
 * TypeError from fetch, not as an HTTP error.
 */
async function fetchIdempotent(
  url: string,
  init: RequestInit,
  attempts = 3
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const retryable = error instanceof TypeError && init.method === "GET";
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
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
    const payload: unknown = await response.json();
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
    const response = await fetch(`${this.baseUrl}/v1/blobs`, {
      method: "POST",
      headers,
      body: new Uint8Array(content)
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
    return this.json("GET", `/v1/runs/${runId}/bundle`);
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
