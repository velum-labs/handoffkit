import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";
import type { OnRateLimitPolicy, PanelRunInput, WireTrajectory } from "../fusion-backend.js";

function candidate(modelId: string, status = "succeeded"): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status, final_output: "ok" };
}

const userTurn = { messages: [{ role: "user", content: "do the task" }] };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type Listening = { url: string; close: () => Promise<void> };

async function listen(server: ReturnType<typeof createServer>): Promise<Listening> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/**
 * A combined mock for the RouteKit chat upstream and internal Fusion sidecar.
 * The chat endpoint is driven by `vendor`; the trajectory-fusion endpoint
 * always returns a fused answer (JSON or SSE).
 */
async function startRouter(
  vendor: (body: Record<string, unknown>, res: ServerResponse) => void
): Promise<Listening & { vendorCalls: () => number; stepCalls: () => number }> {
  let vendorCalls = 0;
  let stepCalls = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (req.url?.includes("trajectories:fuse") === true) {
        stepCalls += 1;
        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "fused answer" }, finish_reason: null }] })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fused answer" } }] }));
        return;
      }
      vendorCalls += 1;
      vendor(body, res);
    })();
  });
  const listening = await listen(server);
  return { ...listening, vendorCalls: () => vendorCalls, stepCalls: () => stepCalls };
}

function quota429Json(_body: Record<string, unknown>, res: ServerResponse): void {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message: "You exceeded your current quota",
        error_category: "quota_exhausted",
        category: "quota_exhausted",
        provider: "openai"
      }
    })
  );
}

function auth401Json(_body: Record<string, unknown>, res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ error: { message: "invalid api key", error_category: "auth_permanent", provider: "openai" } })
  );
}

/** A streaming vendor reply whose first significant event is a pre-stream error. */
function streamingQuota429(_body: Record<string, unknown>, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ error: { error_category: "quota_exhausted", message: "no quota" } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** A streaming vendor reply that fails *after* a content delta (mid-stream). */
function streamingMidStream429(_body: Record<string, unknown>, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial work " } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ error: { error_category: "quota_exhausted", message: "no quota" } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function makeBackend(
  router: Awaited<ReturnType<typeof startRouter>>,
  onRateLimit: OnRateLimitPolicy | undefined,
  panelInputs: PanelRunInput[]
): FusionBackend {
  return new FusionBackend({
    stepUrl: `${router.url}/v1/fusion/trajectories:fuse`,
    runPanels: async (input) => {
      panelInputs.push(input);
      return [candidate("sonnet")];
    },
    defaultModel: "fusion-panel",
    passthrough: [{ routekitModelId: "openai/gpt-5.5", routekitUrl: router.url }],
    ...(onRateLimit !== undefined ? { onRateLimit } : {})
  });
}

test("non-streaming vendor 429 (quota) reroutes the turn to the ensemble", async () => {
  const router = await startRouter(quota429Json);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, undefined, panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: false });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = body.choices[0]?.message.content ?? "";
    assert.match(content, /fused answer/, "the ensemble answer is returned");
    assert.match(content, /handed off to the ensemble/, "a handoff notice is prepended");
    assert.equal(router.stepCalls(), 1, "the fusion step ran");
    assert.equal(panelInputs.length, 1, "the panel ran for the failover turn");
    assert.deepEqual(
      panelInputs[0]?.excludeModelIds,
      ["openai/gpt-5.5"],
      "the throttled vendor is excluded from the failover panel"
    );
  } finally {
    await router.close();
  }
});

test("non-streaming auth-permanent failure fails fast (verbatim, no failover)", async () => {
  const router = await startRouter(auth401Json);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, undefined, panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: false });

    assert.equal(res.status, 401, "the vendor auth error is surfaced verbatim");
    const body = (await res.json()) as { error?: { error_category?: string } };
    assert.equal(body.error?.error_category, "auth_permanent");
    assert.equal(router.stepCalls(), 0, "no failover to the ensemble");
    assert.equal(panelInputs.length, 0, "the panel never ran");
  } finally {
    await router.close();
  }
});

test("streaming pre-stream 429 reroutes and streams the fused answer", async () => {
  const router = await startRouter(streamingQuota429);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, undefined, panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: true });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /handed off to the ensemble/, "the in-stream handoff notice is emitted");
    assert.match(text, /fused answer/, "the fused answer is streamed");
    assert.match(text, /\[DONE\]/);
    assert.equal(panelInputs.length, 1, "the panel ran for the streamed failover");
    assert.deepEqual(panelInputs[0]?.excludeModelIds, ["openai/gpt-5.5"]);
  } finally {
    await router.close();
  }
});

test("streaming mid-stream failure emits a one-tap resume notice (no transparent cutover)", async () => {
  const router = await startRouter(streamingMidStream429);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, undefined, panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: true });

    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /partial work/, "the already-streamed vendor content is preserved");
    assert.match(text, /Re-run on the/, "a one-tap resume notice is spliced in");
    assert.match(text, /fusion-panel/, "the resume notice points at the fused model");
    assert.doesNotMatch(text, /fused answer/, "the ensemble is NOT silently spliced mid-stream");
    assert.equal(panelInputs.length, 0, "mid-stream failures do not run the panel");
    assert.equal(router.stepCalls(), 0);
  } finally {
    await router.close();
  }
});

test("--on-rate-limit passthrough returns the vendor 429 verbatim", async () => {
  const router = await startRouter(quota429Json);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, "passthrough", panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: false });

    assert.equal(res.status, 429, "the vendor response is returned untouched");
    assert.equal(router.stepCalls(), 0);
    assert.equal(panelInputs.length, 0);
  } finally {
    await router.close();
  }
});

test("--on-rate-limit fail surfaces a clear gateway error instead of failing over", async () => {
  const router = await startRouter(quota429Json);
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, "fail", panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: false });

    assert.equal(res.status, 429);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /failover disabled by --on-rate-limit fail/);
    assert.equal(router.stepCalls(), 0, "no failover");
    assert.equal(panelInputs.length, 0);
  } finally {
    await router.close();
  }
});

test("a successful vendor passthrough is untouched (no failover machinery)", async () => {
  const router = await startRouter((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "native answer" } }] }));
  });
  const panelInputs: PanelRunInput[] = [];
  try {
    const backend = makeBackend(router, undefined, panelInputs);
    const res = await backend.chat({ ...userTurn, model: "openai/gpt-5.5", stream: false });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "native answer");
    assert.equal(panelInputs.length, 0, "a healthy vendor call never touches the ensemble");
    assert.equal(router.stepCalls(), 0);
  } finally {
    await router.close();
  }
});
