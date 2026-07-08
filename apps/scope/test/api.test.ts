import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SessionDetail } from "../lib/sessions";

// Isolated DB for the handler-level e2e.
process.env.SCOPEKIT_DB = join(mkdtempSync(join(tmpdir(), "scope-api-")), "scope.db");

const { POST: ingestTraces } = await import("../app/api/ingest/v1/traces/route");
const { POST: ingestLogs } = await import("../app/api/ingest/v1/logs/route");
const { GET: listSessionsRoute } = await import("../app/api/sessions/route");
const { GET: getSessionRoute } = await import("../app/api/sessions/[traceId]/route");
const { GET: modelsRoute } = await import("../app/api/models/route");
const { GET: environmentsRoute } = await import("../app/api/environments/route");
const { syntheticSession, toOtlpExport, toOtlpLogsExport } = await import("./fixture");

test("POST OTLP traces + logs then GET /api/sessions/[id] renders structured detail", async () => {
  const traceId = "33333333333333333333333333330001";
  const { spans, events } = syntheticSession(traceId);

  const tracesResponse = await ingestTraces(
    new Request("http://localhost/api/ingest/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toOtlpExport(spans))
    })
  );
  const tracesBody = (await tracesResponse.json()) as { accepted: number };
  assert.equal(tracesBody.accepted, spans.length);

  const logsResponse = await ingestLogs(
    new Request("http://localhost/api/ingest/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toOtlpLogsExport(events))
    })
  );
  const logsBody = (await logsResponse.json()) as { accepted: number };
  assert.equal(logsBody.accepted, events.length);

  // Sessions list includes the new session (with its prompt preview).
  const listResponse = await listSessionsRoute();
  const listBody = (await listResponse.json()) as {
    sessions: Array<{ traceId: string; status: string; promptPreview: string | null }>;
  };
  const summary = listBody.sessions.find((session) => session.traceId === traceId);
  assert.ok(summary);
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.promptPreview, "Fix the add() sign bug so npm test passes.");

  // Detail derives candidates, judge, and final output from spans + events.
  const detailResponse = await getSessionRoute(new Request(`http://localhost/api/sessions/${traceId}`), {
    params: Promise.resolve({ traceId })
  });
  const detailBody = (await detailResponse.json()) as { session: SessionDetail };
  const detail = detailBody.session;
  assert.equal(detail.candidates.length, 2);
  assert.equal(detail.candidates.find((c) => c.candidateId === "cand_gpt")?.steps.length, 3);
  assert.equal(detail.judge.final?.decision, "synthesize");
  assert.match(detail.finalOutput ?? "", /left \+ right/);
  assert.equal(detail.events.length, events.length);

  // Models + environments rollups reflect the session.
  const modelsBody = (await (await modelsRoute()).json()) as {
    models: Array<{ modelId: string }>;
    costs: { entries: number };
  };
  assert.ok(modelsBody.models.some((model) => model.modelId === "gpt"));
  assert.equal(modelsBody.costs.entries, 3);

  const envBody = (await (await environmentsRoute()).json()) as {
    environments: Array<{ repo?: string; models: unknown[] }>;
  };
  assert.ok(envBody.environments.some((environment) => environment.repo === "/tmp/fusion-sample"));
});

test("GET /api/sessions/[id] 404s for an unknown trace", async () => {
  const response = await getSessionRoute(new Request("http://localhost/api/sessions/nope"), {
    params: Promise.resolve({ traceId: "44444444444444444444444444440000" })
  });
  assert.equal(response.status, 404);
});
