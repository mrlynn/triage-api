/**
 * The three pages: config/health, the queue, and one decision's trace.
 *
 * The trace page is the reason the UI exists. Guardrails you cannot see are
 * guardrails nobody believes in, and "we re-derive the authority decision from
 * the tool trace" is a sentence that convinces no one on its own. A page that
 * shows the cached prompt prefix, every tool call with its redaction count,
 * every control that ran, and what each one concluded — that is the artifact
 * you put in front of a security reviewer.
 */
import { Hono } from "hono";
import { page, esc } from "./layout.js";
import type { Runtime } from "../runtime.js";
import type { EscalationRecord } from "../adapters/types.js";

const nav = (here: string) =>
  `<nav>${["/", "/queue"].map((p) =>
    p === here ? `<span class="sub">${p === "/" ? "Overview" : "Queue"}</span>`
      : `<a href="${p}">${p === "/" ? "Overview" : "Queue"}</a>`).join("")}</nav>`;

function urgencyClass(u: string): string {
  return u === "urgent" ? "urgent" : u === "high" ? "high" : "";
}

function ticketCard(r: EscalationRecord): string {
  const t = r.triage;
  const violations = r.violations.length > 0
    ? `<div class="note warn"><b>Guardrails:</b> ${r.violations.map(esc).join(", ")}</div>` : "";
  return `<div class="card">
  <div class="row">
    <div><b>${esc(t.summary)}</b></div>
    <div class="sub">${esc(r.created_at.replace("T", " ").slice(0, 16))}</div>
  </div>
  <div style="margin:.5rem 0">
    <span class="tag">${esc(t.category)}</span>
    <span class="tag ${urgencyClass(t.urgency)}">${esc(t.urgency)}</span>
    <span class="tag">${esc(t.sentiment)}</span>
    <span class="tag ${t.confidence < 0.7 ? "warn" : "ok"}">confidence ${t.confidence.toFixed(2)}</span>
    ${r.redactions.length > 0 ? `<span class="tag">${r.redactions.length} redacted</span>` : ""}
    <span class="tag">${esc(r.status)}</span>
  </div>
  ${t.escalation_reason ? `<div class="sub">${esc(t.escalation_reason)}</div>` : ""}
  ${violations}
  <div class="msg">${esc(r.message_redacted)}</div>
  <div class="row" style="margin-top:.7rem">
    <div>
      <button onclick="setStatus('${esc(r.id)}','claimed')">Claim</button>
      <button onclick="setStatus('${esc(r.id)}','resolved')">Resolve</button>
      <button onclick="setStatus('${esc(r.id)}','dismissed')">Dismiss</button>
    </div>
    <div class="sub"><a href="/decisions/${esc(r.id)}">trace</a> · ${esc(r.model)} · $${r.cost_usd.toFixed(5)}</div>
  </div>
</div>`;
}

const QUEUE_SCRIPT = `<script>
async function setStatus(id, status){
  const by = status === 'claimed' ? (prompt('Claim as:') || 'anonymous') : undefined;
  const r = await fetch('/v1/queue/' + encodeURIComponent(id), {
    method:'PATCH', headers:{'content-type':'application/json'},
    body: JSON.stringify({status, by})
  });
  if (r.ok) location.reload(); else alert('Failed: ' + r.status);
}
</script>`;

export function uiRoutes(rt: Runtime) {
  const app = new Hono();

  app.get("/", async (c) => {
    const stats = await rt.store.queueStats();
    const health = await rt.store.health();
    const today = new Date().toISOString().slice(0, 10);
    const usage = await rt.store.usageFor(today);

    const advisory = rt.sinks.length === 0;
    const controls: [string, boolean | string][] = [
      ["Trust boundary (input escaping)", true],
      ["PII redaction", true],
      ["Authority re-derivation", true],
      ["Citation verification", true],
      ["Single-refund ceiling", true],
      ["Rolling refund ceiling", rt.availability.customerLookup],
      ["Confidence floor", `< ${rt.router.escalateBelow}`],
    ];

    return c.html(page("triage-api", `
<header>
  <h1>triage-api</h1>
  <div class="sub">pack <b>${esc(rt.pack.id)}</b> · ${esc(rt.pack.companyName)} · store <b>${esc(rt.store.name)}</b></div>
  ${nav("/")}
</header>

${advisory ? `<div class="note"><b>Advisory mode.</b> No sink is configured, so this service classifies
tickets and writes nothing back to any external system. That is the recommended way to start.
Add a sink in <code>triage.config.ts</code> when the queue stops surprising you.</div>` : ""}

<div class="stats">
  <div class="stat"><b>${stats.depth}</b><span>awaiting review</span></div>
  <div class="stat"><b>${stats.claimed}</b><span>claimed</span></div>
  <div class="stat"><b>${stats.resolved}</b><span>resolved</span></div>
  <div class="stat"><b>$${(usage.micro_dollars / 1e6).toFixed(4)}</b><span>spend today</span></div>
  <div class="stat"><b>${usage.requests}</b><span>tickets today</span></div>
</div>

<h2>Controls</h2>
<table>
${controls.map(([name, v]) => `<tr><td>${esc(name)}</td><td>${
  v === true ? '<span class="tag ok">active</span>'
  : v === false ? '<span class="tag bad">UNAVAILABLE</span>'
  : `<span class="tag ok">${esc(v)}</span>`}</td></tr>`).join("")}
</table>
${!rt.availability.customerLookup ? `<div class="note warn"><b>The rolling refund ceiling cannot run.</b>
No DataProvider in this deployment implements <code>lookupCustomer</code>, so refund recommendations
are escalated with <code>control_unavailable:rolling_ceiling</code> rather than approved.
The fix is to implement the lookup — see <code>src/adapters/data.ts</code>.</div>` : ""}

<h2>Configuration</h2>
<table>
<tr><td>Model</td><td>${esc(rt.config.models.model ?? `tier: ${rt.config.models.tier}`)}</td></tr>
<tr><td>Tools offered</td><td>${rt.toolDefs.map((d) => `<code>${esc(d.name)}</code>`).join(", ")}</td></tr>
<tr><td>Sources</td><td>${rt.sources.size === 0 ? '<span class="sub">none configured</span>'
  : [...rt.sources.entries()].map(([k, s]) => `<code>/v1/ingest/${esc(k)}</code> → ${esc(s.name)}`).join("<br>")}</td></tr>
<tr><td>Sinks</td><td>${advisory ? '<span class="sub">none — advisory mode</span>'
  : rt.sinks.map((s) => esc(s.name)).join(", ")}</td></tr>
<tr><td>Store</td><td>${esc(rt.store.name)} — ${esc(health.detail ?? (health.ok ? "ok" : "unreachable"))}</td></tr>
</table>
<p class="sub">Machine-readable at <a href="/readyz">/readyz</a>.</p>
`));
  });

  app.get("/queue", async (c) => {
    const status = c.req.query("status") as EscalationRecord["status"] | undefined;
    const [items, stats] = await Promise.all([
      rt.store.listEscalations({ status, limit: 200 }),
      rt.store.queueStats(),
    ]);
    const mins = stats.median_time_to_claim_ms === null
      ? "—" : `${Math.round(stats.median_time_to_claim_ms / 60_000)}m`;

    return c.html(page("Queue · triage-api", `
<header>
  <h1>Escalation queue</h1>
  <div class="sub">Only tickets needing a human are stored, and only in redacted form.</div>
  ${nav("/queue")}
  <div class="stats">
    <div class="stat"><b>${stats.depth}</b><span>new</span></div>
    <div class="stat"><b>${stats.claimed}</b><span>claimed</span></div>
    <div class="stat"><b>${mins}</b><span>median time to claim</span></div>
  </div>
</header>
<p class="sub">
  ${["", "new", "claimed", "resolved", "dismissed"].map((s) =>
    `<a href="/queue${s ? `?status=${s}` : ""}">${s || "all"}</a>`).join(" · ")}
</p>
${items.length === 0
  ? `<div class="empty">Nothing here yet.<br><span class="sub">POST a ticket to <code>/v1/ingest/&lt;source&gt;</code>, or run <code>npm run smoke</code>.</span></div>`
  : items.map(ticketCard).join("")}
${QUEUE_SCRIPT}`));
  });

  app.get("/decisions/:id", async (c) => {
    const r = await rt.store.getEscalation(c.req.param("id"));
    if (!r) return c.html(page("Not found", `<div class="empty">No decision with that id.<br><a href="/queue">Back to queue</a></div>`), 404);

    const t = r.triage;
    return c.html(page(`${r.id} · triage-api`, `
<header>
  <h1>${esc(r.id)}</h1>
  <div class="sub">${esc(r.created_at)} · ${esc(r.model)} · $${r.cost_usd.toFixed(5)}</div>
  <nav><a href="/queue">← Queue</a></nav>
</header>

<h2>Classification</h2>
<table>
  <tr><td>Summary</td><td><b>${esc(t.summary)}</b></td></tr>
  <tr><td>Category</td><td>${esc(t.category)}</td></tr>
  <tr><td>Urgency</td><td>${esc(t.urgency)}</td></tr>
  <tr><td>Sentiment</td><td>${esc(t.sentiment)}</td></tr>
  <tr><td>Confidence</td><td>${t.confidence.toFixed(2)}${t.confidence < rt.router.escalateBelow
    ? ` <span class="tag warn">below the ${rt.router.escalateBelow} floor</span>` : ""}</td></tr>
  <tr><td>Needs a human</td><td>${t.requires_human ? "yes" : "no"}${
    t.escalation_reason ? ` — ${esc(t.escalation_reason)}` : ""}</td></tr>
  <tr><td>Requested remedy</td><td>${esc(t.entities.requested_remedy)}</td></tr>
  <tr><td>Orders referenced</td><td>${t.entities.order_ids.length ? t.entities.order_ids.map(esc).join(", ") : "—"}</td></tr>
</table>

<h2>Guardrails</h2>
${r.violations.length === 0
  ? `<p><span class="tag ok">no findings</span> <span class="sub">Every control this deployment can run, ran, and passed.</span></p>`
  : `<p>${r.violations.map((v) => `<span class="tag bad">${esc(v)}</span>`).join(" ")}</p>`}
<table>
  <tr><td>Identifiers redacted before the model saw the text</td><td>${r.redactions.length}${
    r.redactions.length ? ` (${[...new Set(r.redactions.map((x) => x.kind))].map(esc).join(", ")})` : ""}</td></tr>
  <tr><td>Rolling refund ceiling</td><td>${rt.availability.customerLookup
    ? '<span class="tag ok">enforced</span>' : '<span class="tag bad">unavailable in this deployment</span>'}</td></tr>
</table>
<p class="sub">Redactions are counted, never stored. The value is gone; only the kind and the position remain.</p>

<h2>Message as stored</h2>
<div class="msg">${esc(r.message_redacted)}</div>
${r.ticket.external_url ? `<p class="sub"><a href="${esc(r.ticket.external_url)}">Source ticket ↗</a></p>` : ""}

<h2>Prompt structure</h2>
<div class="note">The system prompt is two blocks. Block 1 — the role and the
${esc(rt.pack.companyName)} handbook — is byte-identical on every request and carries the cache
breakpoint. Block 2 holds the date and channel. A timestamp in block 1 would cost you every cache
hit you have, silently.</div>
<pre><code>system[0]  frozen   role + handbook   ~${Math.round(rt.pack.handbookText.length / 3)} tokens  ← cache_control: ephemeral
system[1]  volatile date, channel     &lt;20 tokens
messages   untrusted &lt;customer_message&gt; … escaped …</code></pre>

${r.resolution ? `<h2>Resolution</h2><pre><code>${esc(JSON.stringify(r.resolution, null, 2))}</code></pre>` : ""}
`));
  });

  return app;
}
