import type { RunRequest } from "../plane/store.js";
import type { ClaimResult, DisclosureReport } from "../plane/plane.js";
import type {
  ActorRef,
  ChainedEvent,
  Receipt,
  ReceiptBundle,
  RunStatus
} from "../protocol/types.js";

export type RunRequestInput = Omit<RunRequest, "runId">;

export type RunView = {
  runId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  consentRequirements: string[];
  failureMessage?: string;
  events: ChainedEvent[];
};

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

/** Thin HTTP client over the plane API, shared by the CLI, SDK, and runner. */
export class PlaneClient {
  private readonly baseUrl: string;
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
    const response = await fetch(`${this.baseUrl}${path}`, {
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
    const response = await fetch(`${this.baseUrl}/v1/blobs/${hash}`);
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

  getRun(runId: string): Promise<RunView> {
    return this.json("GET", `/v1/runs/${runId}`);
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
    const response = await fetch(`${this.baseUrl}/v1/export${query}`, { headers });
    if (!response.ok) {
      throw new PlaneClientError(response.status, await response.json());
    }
    return response.text();
  }
}
