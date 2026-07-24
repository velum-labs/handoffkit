import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LAUNCH_ROUTE_IDS } from "../launch-support.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const routekitCli = join(root, "packages", "routekit-cli", "dist", "index.js");
const cliEnv = { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" };
const routeDisclosuresPath = "apps/docs/content/docs/reference/routes-and-billing.mdx";

function help(args: readonly string[]): string {
  return execFileSync(process.execPath, [routekitCli, ...args], {
    encoding: "utf8",
    env: cliEnv
  });
}

test("documented safe CLI commands remain executable", () => {
  for (const [cli, args] of [
    [routekitCli, ["start", "--help"]],
    [routekitCli, ["status", "--help"]],
    [routekitCli, ["stop", "--help"]],
    [routekitCli, ["accounts", "add", "--help"]],
    [routekitCli, ["providers", "add", "--help"]],
    [routekitCli, ["accounts", "login", "--help"]],
    [routekitCli, ["accounts", "remove", "--help"]]
  ] as const) {
    const output = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: cliEnv
    });
    assert.match(output, /Usage:/);
  }
  // The cliproxy subtree is gone from the public accounts surface.
  const accountsHelp = help(["accounts", "--help"]);
  assert.match(accountsHelp, /\blogin\b/);
  assert.doesNotMatch(accountsHelp, /\bcliproxy\b/);

  const rootHelp = execFileSync(process.execPath, [routekitCli, "--help"], {
    encoding: "utf8",
    env: { ...process.env, FUSIONKIT_NO_TUI: "1", ROUTEKIT_NO_TUI: "1" }
  });
  assert.match(rootHelp, /^\s+start\b/m);
  assert.match(rootHelp, /^\s+status\b/m);
  assert.match(rootHelp, /^\s+stop\b/m);
  assert.doesNotMatch(rootHelp, /^\s+daemon\b/m);
  assert.doesNotMatch(rootHelp, /^\s+gateway\b/m);
});

test("first-launch help exposes only supported RouteKit routes", () => {
  const rootHelp = help(["--help"]);
  for (const command of ["codex", "claude", "cursor", "accounts", "providers"]) {
    assert.match(rootHelp, new RegExp(`^  ${command}(?:[ <\\[]|$)`, "m"));
  }
  assert.doesNotMatch(rootHelp, /\bopencode\b/i);

  const loginHelp = help(["accounts", "login", "--help"]);
  assert.match(loginHelp, /claude-code, codex/);
  assert.doesNotMatch(loginHelp, /\b(?:gemini|grok|kimi|cliproxy)\b/i);
});

test("public RouteKit docs contain no not-offered onboarding commands", () => {
  for (const path of [
    "README.md",
    "packages/routekit-cli/README.md",
    "docs/configuration.md",
    "docs/routekit-user-guide.md",
    "docs/subscription-pooling.md",
    "apps/docs/content/docs/getting-started/routekit.mdx",
    "apps/docs/content/docs/guides/subscription-pooling.mdx",
    "apps/docs/content/docs/getting-started/installation.mdx",
    "configs/models.example.yaml"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(
      source,
      /\broutekit\s+(?:opencode\b|accounts\s+login\s+(?:gemini|grok|kimi)\b|providers\s+add\s+(?:google|cliproxy)\b)/i,
      `${path} advertises a route that is not offered at first launch`
    );
  }
});

test("zero-context RouteKit guides keep viable first-launch paths", () => {
  for (const path of [
    "docs/routekit-user-guide.md",
    "apps/docs/content/docs/getting-started/routekit.mdx"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    for (const expected of [
      "npm install -g @velum-labs/routekit",
      "export OPENAI_API_KEY=",
      "routekit config init",
      "providers: {}",
      "routekit config import --from ./routekit.yaml",
      "npm install -g @anthropic-ai/claude-code",
      "npm install -g @openai/codex",
      "routekit accounts login claude-code --name personal",
      "routekit accounts login codex --name personal",
      "routekit start",
      "routekit models list",
      "routekit models info",
      "routekit calls inspect",
      "/v1/chat/completions"
    ]) {
      assert.ok(source.includes(expected), `${path} is missing ${expected}`);
    }
    assert.ok(
      source.indexOf("providers: {}") <
        source.indexOf("routekit accounts login claude-code --name personal"),
      `${path} must bootstrap an empty config before subscription-only login`
    );
    assert.ok(
      source.indexOf("npm install -g @anthropic-ai/claude-code") <
        source.indexOf("routekit accounts login claude-code --name personal"),
      `${path} must install Claude Code before its login flow`
    );
    assert.ok(
      source.indexOf("npm install -g @openai/codex") <
        source.indexOf("routekit accounts login codex --name personal"),
      `${path} must install Codex before its login flow`
    );
  }
});

test("retained implementation references are explicitly non-contractual", () => {
  for (const path of [
    "packages/accounts/README.md",
    "apps/docs/content/docs/reference/packages.mdx",
    "docs/packages.md",
    "configs/benchmark-router.example.yaml",
    "docs/routekit-account-activation-evidence.md"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(
      source,
      /non-contractual|not first-launch qualification|does not add them to RouteKit's launch support/i,
      `${path} does not label retained implementation details as non-contractual`
    );
  }

  const installation = readFileSync(
    join(root, "apps/docs/content/docs/getting-started/installation.mdx"),
    "utf8"
  );
  assert.match(installation, /accounts login claude-code/);
  assert.match(installation, /accounts login codex/);
  assert.doesNotMatch(installation, /accounts add <kind>/);

  for (const path of ["CHANGELOG.md", "apps/docs/content/docs/changelog.mdx"]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(
      source,
      /retained internal Google[\s\S]{0,120}outside RouteKit's public\s+support contract/i,
      `${path} does not distinguish the retained Google backend from public support`
    );
  }
});

test("every first-launch route has a complete public disclosure", () => {
  const source = readFileSync(join(root, routeDisclosuresPath), "utf8");
  const mirror = readFileSync(join(root, "docs/routekit-routes-and-billing.md"), "utf8");
  const routeIds = [...LAUNCH_ROUTE_IDS];
  const evidenceMapping = JSON.parse(
    readFileSync(join(root, "spec/routekit/l06-evidence-map.json"), "utf8")
  ) as { routes: Array<{ id: string; requiredCaseIds: string[] }> };
  const evidenceReport = JSON.parse(
    readFileSync(join(root, "docs/routekit-l06-evidence.json"), "utf8")
  ) as {
    mappingDigest: string;
    routekitVersion: string;
    routes: Record<
      string,
      {
        qualificationStatus: "pending" | "qualified" | "failed";
        evidence: Array<{ caseId?: string; reference: string; status: string; type: string }>;
      }
    >;
  };
  const evidenceMarkdown = readFileSync(join(root, "docs/routekit-l06-evidence.md"), "utf8");
  assert.deepEqual(
    evidenceMapping.routes.map((route) => route.id),
    routeIds,
    "L06 evidence mapping drifted from the launch route contract"
  );
  assert.deepEqual(
    Object.keys(evidenceReport.routes),
    routeIds,
    "durable L06 report must cover exactly the launch routes"
  );
  assert.match(evidenceReport.mappingDigest, /^[0-9a-f]{64}$/);
  assert.match(evidenceMarkdown, new RegExp(evidenceReport.mappingDigest));
  const requiredFields = [
    "**Status and evidence:**",
    "**Credential:**",
    "**Billing:**",
    "**Egress and aggregator:**",
    "**Quota and failover:**",
    "**Protocol and limitations:**",
    "**Unlimited use:**"
  ];
  const requiredMirrorFields = [
    "**Credential / owner:**",
    "**Billing / egress:**",
    "**Quota / fallback:**",
    "**Protocol / limitations:**",
    "**Evidence:**"
  ];

  for (const [index, routeId] of routeIds.entries()) {
    const anchor = `<a id="${routeId}"></a>`;
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `${routeDisclosuresPath} is missing ${routeId}`);
    const nextAnchor =
      index + 1 < routeIds.length ? `<a id="${routeIds[index + 1]}"></a>` : "## Qualification evidence";
    const end = source.indexOf(nextAnchor, start + anchor.length);
    assert.notEqual(end, -1, `${routeDisclosuresPath} cannot delimit ${routeId}`);
    const section = source.slice(start, end);

    for (const field of requiredFields) {
      assert.ok(section.includes(field), `${routeId} is missing ${field}`);
    }
    assert.match(
      section,
      new RegExp(
        `github\\.com/velum-labs/handoffkit/blob/main/docs/routekit-l06-evidence\\.md#${routeId}`
      ),
      `${routeId} does not link its stable durable evidence row`
    );
    assert.match(
      section,
      new RegExp(`RouteKit ${evidenceReport.routekitVersion.replaceAll(".", "\\.")}`)
    );
    assert.match(section, /\b20\d{2}-\d{2}-\d{2}\b/);
    assert.match(section, /makes no unlimited-use claim/i);

    const mirrorAnchor = `<a id="${routeId}"></a>`;
    const mirrorStart = mirror.indexOf(mirrorAnchor);
    assert.notEqual(mirrorStart, -1, `maintainer mirror is missing ${routeId}`);
    const nextMirrorAnchor =
      index + 1 < routeIds.length
        ? `<a id="${routeIds[index + 1]}"></a>`
        : "## Qualification requirement";
    const mirrorEnd = mirror.indexOf(nextMirrorAnchor, mirrorStart + mirrorAnchor.length);
    assert.notEqual(mirrorEnd, -1, `maintainer mirror cannot delimit ${routeId}`);
    const mirrorSection = mirror.slice(mirrorStart, mirrorEnd);
    for (const field of requiredMirrorFields) {
      assert.ok(mirrorSection.includes(field), `maintainer mirror ${routeId} is missing ${field}`);
    }
    assert.match(
      mirrorSection,
      new RegExp(`routekit-l06-evidence\\.md#${routeId}`),
      `maintainer mirror ${routeId} does not link its durable evidence row`
    );
    assert.match(
      mirrorSection,
      new RegExp(`RouteKit ${evidenceReport.routekitVersion.replaceAll(".", "\\.")}`)
    );
    assert.match(mirrorSection, /\b20\d{2}-\d{2}-\d{2}\b/);

    const mapped = evidenceMapping.routes[index];
    assert.equal(mapped?.id, routeId);
    const evidence = evidenceReport.routes[routeId];
    assert.ok(evidence !== undefined, `${routeId} has no durable evidence`);
    const caseIds = new Set(evidence.evidence.flatMap((item) => item.caseId ?? []));
    for (const caseId of mapped.requiredCaseIds) {
      assert.ok(caseIds.has(caseId), `${routeId} lacks mapped evidence ${caseId}`);
    }
    assert.ok(
      evidence.evidence.every(
        (item) =>
          ["automated", "manual"].includes(item.type) &&
          ["pending", "pass", "fail"].includes(item.status) &&
          item.reference.length > 0
      ),
      `${routeId} contains incomplete evidence`
    );
    assert.match(evidenceMarkdown, new RegExp(`<a id="${routeId}"></a>`));
  }

  const registry = JSON.parse(
    readFileSync(join(root, "spec/registry/providers.json"), "utf8")
  ) as {
    providers: Record<string, { baseUrl?: string; keyEnv?: string }>;
  };
  for (const [routeId, providerId] of [
    ["route-openai-api", "openai"],
    ["route-anthropic-api", "anthropic"],
    ["route-openrouter-api", "openrouter"]
  ] as const) {
    const start = source.indexOf(`<a id="${routeId}"></a>`);
    const end = source.indexOf("<a id=", start + 1);
    const section = source.slice(start, end);
    const provider = registry.providers[providerId];
    assert.ok(provider?.keyEnv !== undefined);
    assert.ok(provider.baseUrl !== undefined);
    assert.match(section, new RegExp(provider.keyEnv));
    assert.match(section, new RegExp(new URL(provider.baseUrl).hostname.replaceAll(".", "\\.")));
  }
  const anthropic = source.slice(
    source.indexOf('<a id="route-anthropic-api"></a>'),
    source.indexOf('<a id="route-openrouter-api"></a>')
  );
  assert.match(anthropic, /does not\s+currently use `ANTHROPIC_AUTH_TOKEN`/);

  const openRouter = source.slice(
    source.indexOf('<a id="route-openrouter-api"></a>'),
    source.indexOf('<a id="route-codex-subscription"></a>')
  );
  assert.match(openRouter, /OpenRouter is an aggregator/i);
  assert.match(openRouter, /upstream provider/i);
  assert.match(openRouter, /prompts, code, tool data, and model requests/i);

  const evidenceRevision = source.match(
    /github\.com\/velum-labs\/handoffkit\/commit\/([0-9a-f]{40})/
  )?.[1];
  assert.ok(evidenceRevision !== undefined, "public disclosure lacks an immutable evidence revision");
  assert.match(mirror, new RegExp(evidenceRevision));
  assert.match(
    source,
    new RegExp(
      `github\\.com/velum-labs/handoffkit/blob/${evidenceRevision}/docs/routekit-e2e-matrix\\.md`
    )
  );
});

test("route explanation contract is documented in public and maintainer surfaces", () => {
  const publicDoc = readFileSync(join(root, routeDisclosuresPath), "utf8");
  const mirror = readFileSync(
    join(root, "docs/routekit-routes-and-billing.md"),
    "utf8"
  );
  const readme = readFileSync(
    join(root, "packages/routekit-cli/README.md"),
    "utf8"
  );
  for (const source of [publicDoc, mirror, readme]) {
    assert.match(source, /routekit models info <provider\/model>/);
    assert.match(source, /native model/i);
    assert.match(source, /account class/i);
    assert.match(source, /billing mode/i);
    assert.match(source, /api-key[\s\S]{0,80}metered-api/);
    assert.match(source, /subscription[\s\S]{0,80}subscription/);
    assert.match(source, /unknown models? fail|unknown[\s\S]{0,80}rejected/i);
    assert.match(source, /credential/i);
  }
  assert.match(mirror, /routekit-route-info-evidence\.md/);
  assert.match(publicDoc, /routekit-route-info-evidence\.md/);
});

test("public onboarding links to the route disclosure contract", () => {
  const packageReadme = readFileSync(join(root, "packages/routekit-cli/README.md"), "utf8");
  assert.match(
    packageReadme,
    /\]\(https:\/\/fusionkit\.velum-labs\.com\/docs\/reference\/routes-and-billing\)/
  );

  for (const path of [
    "apps/docs/content/docs/getting-started/installation.mdx",
    "apps/docs/content/docs/getting-started/routekit.mdx",
    "apps/docs/content/docs/concepts/privacy.mdx"
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /\]\(\/docs\/reference\/routes-and-billing(?:#[^)]+)?\)/);
  }
});
