import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionDetail } from "../lib/sessions";

// Isolated DB for the handler-level e2e.
process.env.SCOPEKIT_DB = join(mkdtempSync(join(tmpdir(), "scope-api-")), "scope.db");

const { POST: ingest } = await import("../app/api/ingest/route");
const { GET: listSessionsRoute } = await import("../app/api/sessions/route");
const { GET: getSessionRoute } = await import("../app/api/sessions/[traceId]/route");
const { GET: modelsRoute } = await import("../app/api/models/route");
const { GET: environmentsRoute } = await import("../app/api/environments/route");
const { syntheticSession } = await import("./fixture");

test("POST /api/ingest then GET /api/sessions/[id] renders structured detail", async () => {
  const traceId = "trace_api_e2e";
  const events = syntheticSession(traceId);

  const ingestResponse = await ingest(
    new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events })
    })
  );
  const ingestBody = (await ingestResponse.json()) as { accepted: number; rejected: number };
  assert.equal(ingestBody.accepted, events.length);
  assert.equal(ingestBody.rejected, 0);

  // Sessions list includes the new session.
  const listResponse = await listSessionsRoute();
  const listBody = (await listResponse.json()) as { sessions: Array<{ traceId: string; status: string }> };
  const summary = listBody.sessions.find((session) => session.traceId === traceId);
  assert.ok(summary);
  assert.equal(summary.status, "succeeded");

  // Detail derives candidates, judge, and final output.
  const detailResponse = await getSessionRoute(new Request(`http://localhost/api/sessions/${traceId}`), {
    params: Promise.resolve({ traceId })
  });
  const detailBody = (await detailResponse.json()) as { session: SessionDetail };
  const detail = detailBody.session;
  assert.equal(detail.candidates.length, 2);
  assert.equal(detail.candidates.find((c) => c.candidateId === "cand_gpt")?.steps.length, 3);
  assert.equal(detail.judge.final?.decision, "synthesize");
  assert.match(detail.finalOutput ?? "", /left \+ right/);

  // Models + environments rollups reflect the session.
  const modelsBody = (await (await modelsRoute()).json()) as { models: Array<{ modelId: string }> };
  assert.ok(modelsBody.models.some((model) => model.modelId === "gpt"));

  const envBody = (await (await environmentsRoute()).json()) as {
    environments: Array<{ repo?: string; models: unknown[] }>;
  };
  assert.ok(envBody.environments.some((environment) => environment.repo === "/tmp/fusion-sample"));
});

test("GET /api/sessions/[id] 404s for an unknown trace", async () => {
  const response = await getSessionRoute(new Request("http://localhost/api/sessions/nope"), {
    params: Promise.resolve({ traceId: "trace_does_not_exist" })
  });
  assert.equal(response.status, 404);
});
