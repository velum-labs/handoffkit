/* Warrant control panel — dependency-free vanilla JS over the plane API. */
"use strict";

(() => {
  const TOKEN_KEY = "warrant-admin-token";
  const POLL_MS = 2000;

  const el = {
    nav: document.getElementById("nav"),
    topActions: document.getElementById("top-actions"),
    login: document.getElementById("login"),
    loginForm: document.getElementById("login-form"),
    loginError: document.getElementById("login-error"),
    tokenInput: document.getElementById("token-input"),
    view: document.getElementById("view"),
    planeInfo: document.getElementById("plane-info"),
    exportBtn: document.getElementById("export-btn"),
    logoutBtn: document.getElementById("logout-btn")
  };

  let token = localStorage.getItem(TOKEN_KEY) || "";
  let pollTimer = null;

  /* ---------- helpers ---------- */

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);

  const short = (hash, n = 12) => (hash ? String(hash).slice(0, n) : "");

  const when = (iso) => {
    if (!iso) return "";
    const date = new Date(iso);
    const deltaSec = Math.round((Date.now() - date.getTime()) / 1000);
    if (deltaSec < 60) return `${deltaSec}s ago`;
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
    if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
    return date.toISOString().replace("T", " ").slice(0, 19);
  };

  function toast(message, isError) {
    const node = document.createElement("div");
    node.className = "toast" + (isError ? " error" : "");
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 3500);
  }

  async function api(path, options = {}) {
    const headers = Object.assign(
      { authorization: `Bearer ${token}` },
      options.body !== undefined ? { "content-type": "application/json" } : {}
    );
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    if (response.status === 401) {
      showLogin("That token was rejected by the plane.");
      throw new Error("unauthorized");
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  const actor = { kind: "human", id: "control-panel" };

  /* ---------- auth flow ---------- */

  function showLogin(message) {
    stopPolling();
    el.login.hidden = false;
    el.view.hidden = true;
    el.nav.hidden = true;
    el.topActions.hidden = true;
    el.loginError.hidden = !message;
    if (message) el.loginError.textContent = message;
  }

  async function connect() {
    try {
      const { policyHash } = await api("/v1/policy");
      localStorage.setItem(TOKEN_KEY, token);
      el.login.hidden = true;
      el.view.hidden = false;
      el.nav.hidden = false;
      el.topActions.hidden = false;
      el.planeInfo.textContent = `policy ${short(policyHash)} · ${location.host}`;
      route();
    } catch (error) {
      if (error.message !== "unauthorized") {
        showLogin(`Could not reach the plane: ${error.message}`);
      }
    }
  }

  el.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    token = el.tokenInput.value.trim();
    if (token) connect();
  });

  el.logoutBtn.addEventListener("click", () => {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });

  el.exportBtn.addEventListener("click", async () => {
    const response = await fetch("/v1/export", {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      toast("export failed", true);
      return;
    }
    const blob = await response.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "warrant-audit.jsonl";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------- router ---------- */

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedule(fn) {
    stopPolling();
    pollTimer = setTimeout(fn, POLL_MS);
  }

  function setActiveNav(name) {
    for (const link of el.nav.querySelectorAll("a")) {
      link.classList.toggle("active", link.dataset.nav === name);
    }
  }

  function route() {
    if (!token) return;
    stopPolling();
    const hash = location.hash || "#/runs";
    const runMatch = hash.match(/^#\/runs\/([A-Za-z0-9_-]+)$/);
    if (runMatch) {
      setActiveNav("runs");
      renderRunDetail(runMatch[1]);
      return;
    }
    if (hash.startsWith("#/runners")) {
      setActiveNav("runners");
      renderRunners();
      return;
    }
    if (hash.startsWith("#/policy")) {
      setActiveNav("policy");
      renderPolicy();
      return;
    }
    setActiveNav("runs");
    renderRuns();
  }

  window.addEventListener("hashchange", route);

  /* ---------- runs list ---------- */

  async function renderRuns() {
    let runs;
    try {
      ({ runs } = await api("/v1/runs"));
    } catch {
      return;
    }
    if (location.hash && location.hash !== "#/runs" && location.hash !== "") return;

    const pending = runs.filter((r) => r.status === "awaiting_approval").length;
    const rows = runs
      .map((run) => {
        const prompt = run.prompt.length > 64 ? run.prompt.slice(0, 61) + "..." : run.prompt;
        return `<tr class="row-link" data-run="${esc(run.runId)}">
          <td class="mono">${esc(short(run.runId, 16))}…</td>
          <td><span class="chip ${esc(run.status)}">${esc(run.status)}</span></td>
          <td>${esc(run.agentKind)}${run.continuation ? ' <span class="chip continuation" title="continued from a handoff envelope">↩ continuation</span>' : ""}</td>
          <td>${esc(run.pool)}</td>
          <td>${esc(prompt)}</td>
          <td>${esc(run.requestedBy.id)}</td>
          <td class="muted">${esc(when(run.updatedAt))}</td>
        </tr>`;
      })
      .join("");

    el.view.innerHTML = `
      <div class="view-head">
        <h1>Runs</h1>
        <span class="count">${runs.length} total${pending ? ` · <span class="warn" style="color:var(--warn)">${pending} awaiting approval</span>` : ""}</span>
        <span class="spacer"></span>
        <span class="muted">auto-refreshing</span>
      </div>
      ${
        runs.length === 0
          ? `<div class="empty">No runs yet. Start one with<br/><br/><code>warrant run --agent mock "try the kernel"</code></div>`
          : `<table>
              <thead><tr><th>Run</th><th>Status</th><th>Agent</th><th>Pool</th><th>Task</th><th>Requested by</th><th>Updated</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
      }`;
    for (const row of el.view.querySelectorAll("tr.row-link")) {
      row.addEventListener("click", () => {
        location.hash = `#/runs/${row.dataset.run}`;
      });
    }
    schedule(renderRuns);
  }

  /* ---------- run detail ---------- */

  function eventSummary(entry) {
    const e = entry.event;
    switch (e.type) {
      case "run.created": return ["plain", ""];
      case "run.claimed": return ["info", `runner ${e.runnerId} (${e.runnerKeyId})`];
      case "workspace.materialized": return ["info", `manifest ${short(e.manifestHash)}`];
      case "policy.evaluated": return [e.decision === "allow" ? "ok" : "warn", `${e.decision}: ${e.reason}`];
      case "consent.requested": return ["warn", e.requirement];
      case "consent.granted": return ["ok", `by ${e.actor.id}`];
      case "secret.released": return ["warn", `${e.name} (scope ${e.scope}) — value never logged`];
      case "command.executed": return [e.exitCode === 0 ? "ok" : "err", `argv ${short(e.argvHash)} → exit ${e.exitCode}`];
      case "file.changed": return ["plain", `${e.path} → ${short(e.contentHash)}`];
      case "network.connected": return [e.decision === "allowed" ? "ok" : "err", `${e.host} [${e.decision}]`];
      case "model.called": return ["info", `${e.provider}/${e.model}`];
      case "boundary.crossed": return ["warn", `${e.direction}: ${e.dataClass} ${short(e.contentHash)}`];
      case "artifact.created": return ["info", `${e.kind} ${short(e.hash)}`];
      case "checkpoint.created": return ["info", `${e.checkpointId} (tier ${e.tier})`];
      case "run.completed": return ["ok", ""];
      case "run.failed": return ["err", `${e.failure}: ${e.message || ""}`];
      case "run.cancelled": return ["err", `by ${e.actor.id}`];
      default: return ["plain", JSON.stringify(e)];
    }
  }

  function fiveQuestions(bundle) {
    const { contract, receipt, events } = bundle;
    const changed = events.filter((ev) => ev.event.type === "file.changed").length;
    const approvers = (contract.approvedBy || []).map((a) => a.id).join(", ");
    const secrets = receipt.secretsReleased.length
      ? receipt.secretsReleased.map((s) => `${s.name} (${s.scope})`).join(", ")
      : "none";
    const network = receipt.networkAccessed.length
      ? receipt.networkAccessed.map((n) => `${n.host} [${n.decision}]`).join(", ")
      : "no egress attempted";
    const models = receipt.modelsUsed.length
      ? receipt.modelsUsed.map((m) => `${m.provider}/${m.model}`).join(", ")
      : "not observable at session boundary (vendor harness)";
    const continuation = contract.continuation
      ? `<div class="sub">continuation of checkpoint <code>${esc(contract.continuation.checkpointId)}</code> (envelope ${esc(short(contract.continuation.envelopeHash))}, tier ${esc(contract.continuation.tier)})</div>`
      : "";
    return `
      <div class="five-q">
        <div class="q"><h3>1. What moved?</h3>
          <div>in: workspace @ <code>${esc(short(contract.workspace.baseRef))}</code> (manifest ${esc(short(receipt.workspaceIn.manifestHash))})</div>
          ${continuation}
          <div>out: ${changed} file(s) changed, diff ${receipt.workspaceOut.diffHash ? esc(short(receipt.workspaceOut.diffHash)) : "none"}, ${receipt.workspaceOut.artifactHashes.length} artifact(s)</div>
        </div>
        <div class="q"><h3>2. Why did it move?</h3>
          <div>${esc(contract.task.prompt)}</div>
          <div class="sub">requested by ${esc(contract.requestedBy.id)}</div>
        </div>
        <div class="q"><h3>3. Who or what approved it?</h3>
          <div>${approvers ? `approved by ${esc(approvers)}` : "policy: auto-allowed (no consent rule matched)"}</div>
          <div class="sub">policy snapshot ${esc(short(contract.policyHash))}</div>
        </div>
        <div class="q"><h3>4. Which runtime, model, tools, data, and secrets saw it?</h3>
          <div>runner ${esc(receipt.runner.runnerId)} (pool ${esc(receipt.runner.pool)}, attestation: ${esc(receipt.runner.attestationTier)})</div>
          <div class="sub">agent ${esc(contract.agent.kind)} · secrets: ${esc(secrets)} · network: ${esc(network)} · models: ${esc(models)}</div>
        </div>
        <div class="q"><h3>5. How can you resume, inspect, revoke, or reproduce it?</h3>
          <div class="sub">contract ${esc(short(receipt.contractHash, 16))} (signed) · ${receipt.eventCount} hash-chained events, head ${esc(short(receipt.eventsHead))}</div>
          <div class="sub"><code>warrant pull ${esc(receipt.runId)}</code> · <code>warrant verify &lt;bundle.json&gt;</code></div>
        </div>
      </div>`;
  }

  async function renderRunDetail(runId) {
    let view;
    try {
      view = await api(`/v1/runs/${runId}`);
    } catch (error) {
      el.view.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
      return;
    }
    if (location.hash !== `#/runs/${runId}`) return;

    let bundle = null;
    if (view.status === "completed" || view.status === "failed") {
      try {
        bundle = await api(`/v1/runs/${runId}/bundle`);
      } catch {
        bundle = null;
      }
    }

    const terminal = ["completed", "failed", "cancelled"].includes(view.status);
    const cancellable = view.status === "created" || view.status === "awaiting_approval";

    const banner =
      view.status === "awaiting_approval"
        ? `<div class="banner">
            <span>This run is blocked on consent: ${esc(view.consentRequirements.join("; ") || "approval required")}</span>
            <span class="spacer"></span>
            <button class="btn btn-good" id="approve-btn">Approve</button>
          </div>`
        : "";

    const eventsHtml = view.events
      .map((entry) => {
        const [tone, detail] = eventSummary(entry);
        return `<li>
          <span class="seq">${entry.seq}</span>
          <span class="etype ${tone}">${esc(entry.event.type)}</span>
          <span class="edetail">${esc(detail)}</span>
        </li>`;
      })
      .join("");

    el.view.innerHTML = `
      <div class="view-head">
        <a href="#/runs" class="muted" style="text-decoration:none">← runs</a>
        <h1 class="mono">${esc(runId)}</h1>
        <span class="chip ${esc(view.status)}">${esc(view.status)}</span>
        <span class="spacer"></span>
        <div class="actions">
          ${cancellable ? `<button class="btn btn-danger" id="cancel-btn">Cancel</button>` : ""}
          ${bundle ? `<button class="btn" id="bundle-btn">Download bundle</button>` : ""}
        </div>
      </div>
      ${banner}
      <div class="detail-grid">
        <div>
          ${
            bundle
              ? `<div class="card"><h2>Receipt — one screen, five questions</h2>${fiveQuestions(bundle)}
                  <p class="verify-info">Verify without trusting this plane: <code>warrant verify ${esc(runId)}.bundle.json</code></p>
                </div>`
              : `<div class="card"><h2>Receipt</h2><p class="muted">${
                  terminal
                    ? "No receipt is available for this run."
                    : "The receipt is produced when the run reaches a terminal state."
                }</p></div>`
          }
          <div class="card">
            <h2>Run</h2>
            <dl>
              <dt>created</dt><dd>${esc(view.createdAt)}</dd>
              <dt>updated</dt><dd>${esc(view.updatedAt)}</dd>
              ${view.failureMessage ? `<dt>failure</dt><dd>${esc(view.failureMessage)}</dd>` : ""}
            </dl>
          </div>
        </div>
        <div>
          <div class="card">
            <h2>Hash-chained event log (${view.events.length})</h2>
            ${view.events.length ? `<ul class="timeline">${eventsHtml}</ul>` : `<p class="muted">No events yet: the contract is issued when policy allows or consent is granted.</p>`}
          </div>
        </div>
      </div>`;

    const approveBtn = document.getElementById("approve-btn");
    if (approveBtn) {
      approveBtn.addEventListener("click", async () => {
        approveBtn.disabled = true;
        try {
          await api(`/v1/runs/${runId}/approve`, { method: "POST", body: { actor } });
          toast(`approved ${runId}`);
          renderRunDetail(runId);
        } catch (error) {
          toast(error.message, true);
          approveBtn.disabled = false;
        }
      });
    }
    const cancelBtn = document.getElementById("cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", async () => {
        cancelBtn.disabled = true;
        try {
          await api(`/v1/runs/${runId}/cancel`, { method: "POST", body: { actor } });
          toast(`cancelled ${runId}`);
          renderRunDetail(runId);
        } catch (error) {
          toast(error.message, true);
          cancelBtn.disabled = false;
        }
      });
    }
    const bundleBtn = document.getElementById("bundle-btn");
    if (bundleBtn && bundle) {
      bundleBtn.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], {
          type: "application/json"
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${runId}.bundle.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    if (!terminal) schedule(() => renderRunDetail(runId));
  }

  /* ---------- runners ---------- */

  async function renderRunners() {
    let runners;
    try {
      ({ runners } = await api("/v1/runners"));
    } catch {
      return;
    }
    if (!location.hash.startsWith("#/runners")) return;
    el.view.innerHTML = `
      <div class="view-head"><h1>Runners</h1><span class="count">${runners.length} enrolled</span></div>
      ${
        runners.length === 0
          ? `<div class="empty">No runners enrolled. Start one with<br/><br/><code>warrant runner start --pool default</code></div>`
          : `<table>
              <thead><tr><th>Runner</th><th>Pool</th><th>Key</th><th>Enrolled</th><th>Connectivity</th></tr></thead>
              <tbody>${runners
                .map(
                  (runner) => `<tr>
                    <td class="mono">${esc(runner.runnerId)}</td>
                    <td>${esc(runner.pool)}</td>
                    <td class="hash">${esc(runner.keyId)}</td>
                    <td class="muted">${esc(when(runner.enrolledAt))}</td>
                    <td class="muted">outbound-only</td>
                  </tr>`
                )
                .join("")}</tbody>
            </table>`
      }`;
    schedule(renderRunners);
  }

  /* ---------- policy ---------- */

  async function renderPolicy() {
    let snapshot;
    try {
      snapshot = await api("/v1/policy");
    } catch {
      return;
    }
    if (!location.hash.startsWith("#/policy")) return;
    el.view.innerHTML = `
      <div class="view-head">
        <h1>Policy</h1>
        <span class="count">snapshot <span class="hash">${esc(snapshot.policyHash)}</span></span>
      </div>
      <p class="muted">Every contract embeds this content-addressed snapshot; a policy change between dry-run and execution is detectable by hash.</p>
      <pre class="policy">${esc(JSON.stringify(snapshot.policy, null, 2))}</pre>`;
  }

  /* ---------- boot ---------- */

  if (token) {
    connect();
  } else {
    showLogin();
  }
})();
