const examples = {
  pass: {
    problem_statement: "Before the Season 2 trailer launch, is the audience engagement dataset ready for a marketing brief?",
    asset_hint: "season_2_audience_engagement",
    container_hint: "Demo Media Workspace",
    purpose: "marketing planning",
    show_or_campaign: "Season 2 trailer launch",
    asset_type: "audience engagement",
  },
  review: {
    problem_statement: "Can I use the Season 2 campaign audience dataset for a marketing planning brief? Flag any governance gaps.",
    asset_hint: "season_2_campaign_audience",
    container_hint: "Demo Media Workspace",
    purpose: "marketing planning",
    show_or_campaign: "Season 2 trailer launch",
    asset_type: "campaign audience",
  },
  clarify: {
    problem_statement: "Which audience dataset is ready for the Season 2 launch planning brief?",
    asset_hint: "ambiguous_asset",
    container_hint: "Demo Media Workspace",
    purpose: "marketing planning",
  },
  unknown: {
    problem_statement: "Is the audience dataset named in this question ready for a launch brief?",
    asset_hint: "unknown_asset",
    purpose: "marketing planning",
  },
  recovery: {
    problem_statement: "Check the recovery demonstration audience before the launch planning brief.",
    asset_hint: "recovery_demo",
    purpose: "marketing planning",
  },
};

const $ = (selector) => document.querySelector(selector);
const form = $("#run-form");
const problem = $("#problem-statement");
const problemCount = $("#problem-count");
const problemError = $("#problem-error");
const askSection = $("#ask-section");
const clarifySection = $("#clarify-section");
const runSection = $("#run-section");
const resultSection = $("#result-section");
const recoverySection = $("#recovery-section");
const runLive = $("#run-live");
const progressLabels = ["Accepted", "Queued", "Planning", "Resolving asset", "Quality evidence", "Governance evidence", "Lineage evidence", "Composing", "Validating"];
const terminalStates = new Set(["needs_input", "succeeded", "canceled", "expired", "failed"]);
let currentRun = null;
let eventSource = null;
let pollTimer = null;
let lastFocused = null;

function setText(selector, value) {
  const element = typeof selector === "string" ? $(selector) : selector;
  if (element) element.textContent = value == null ? "" : String(value);
  return element;
}

function show(element, visible = true) {
  if (element) element.hidden = !visible;
}

function updateJourney(step) {
  const order = ["ask", "clarify", "run", "decision", "evidence"];
  const index = order.indexOf(step);
  document.querySelectorAll(".journey-step").forEach((item) => {
    const itemIndex = order.indexOf(item.dataset.step);
    item.classList.toggle("is-current", item.dataset.step === step);
    item.classList.toggle("is-done", itemIndex >= 0 && itemIndex < index);
  });
}

function resetStatePanels() {
  show(clarifySection, false);
  show(runSection, false);
  show(resultSection, false);
  show(recoverySection, false);
}

function applyExample(name) {
  const example = examples[name];
  if (!example) return;
  problem.value = example.problem_statement;
  $("#asset-hint").value = example.asset_hint || "";
  $("#container-hint").value = example.container_hint || "";
  $("#purpose").value = example.purpose || "";
  $("#show-or-campaign").value = example.show_or_campaign || "";
  $("#asset-type").value = example.asset_type || "";
  updateCount();
  problem.focus();
}

function updateCount() {
  setText(problemCount, `${problem.value.length.toLocaleString()} / 8,000`);
}

function validateForm() {
  const valid = problem.value.trim().length > 0;
  problemError.hidden = valid;
  if (!valid) problem.focus();
  return valid;
}

function dateValue(id) {
  const value = $(id).value;
  return value ? `${value}T00:00:00.000Z` : undefined;
}

function buildRequest() {
  const body = { schema_version: "run-request@1", problem_statement: problem.value };
  const optional = [["asset_hint", "#asset-hint"], ["container_hint", "#container-hint"], ["purpose", "#purpose"]];
  for (const [key, selector] of optional) if ($(selector).value.trim()) body[key] = $(selector).value.trim();
  const showOrCampaign = $("#show-or-campaign").value.trim();
  const assetType = $("#asset-type").value.trim();
  if (showOrCampaign || assetType) body.media_context = { ...(showOrCampaign ? { show_or_campaign: showOrCampaign } : {}), ...(assetType ? { asset_type: assetType } : {}) };
  const start = dateValue("#time-start");
  const end = dateValue("#time-end");
  if (start && end) body.time_window = { start, end };
  return body;
}

async function submitRun(request = buildRequest()) {
  resetStatePanels();
  show(runSection, true);
  updateJourney("run");
  setText("#run-phase", "Accepted");
  setText("#run-live", "Run accepted");
  $("#submit-run").disabled = true;
  try {
    const response = await fetch("/v1/runs", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(request) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "The run could not be accepted");
    currentRun = data;
    sessionStorage.setItem("gemini-agents-run-id", data.run_id);
    renderRun(data);
    subscribe(data.run_id);
  } catch (error) {
    resetStatePanels();
    updateJourney("ask");
    setText(problemError, error.message);
    problemError.hidden = false;
  } finally {
    $("#submit-run").disabled = false;
  }
}

function subscribe(runId) {
  closeStream();
  if ("EventSource" in window) {
    eventSource = new EventSource(`/v1/runs/${encodeURIComponent(runId)}/events`);
    const eventNames = ["run.accepted", "run.queued", "run.planning", "run.resolving_asset", "evidence.started", "evidence.attempt", "evidence.partial", "policy.computed", "writer.started", "writer.fallback", "verifier.started", "run.needs_input", "run.succeeded", "run.failed", "run.cancel_requested", "run.canceled"];
    for (const name of eventNames) eventSource.addEventListener(name, onEvent);
    eventSource.onerror = () => startPolling(runId);
  }
  startPolling(runId);
}

function closeStream() {
  if (eventSource) eventSource.close();
  eventSource = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling(runId) {
  if (pollTimer) return;
  pollTimer = setInterval(() => refreshRun(runId), 450);
}

function onEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    const display = payload.display || "Run updated";
    setText(runLive, display);
    refreshRun(payload.run_id);
  } catch {
    startPolling(currentRun?.run_id);
  }
}

async function refreshRun(runId) {
  if (!runId) return;
  try {
    const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Run is no longer available");
    const data = await response.json();
    currentRun = data;
    renderRun(data);
    if (terminalStates.has(data.state)) closeStream();
  } catch {
    // Keep the last safe projection visible while a refresh is retried.
  }
}

function renderRun(run) {
  const active = !terminalStates.has(run.state);
  $("#run-section").setAttribute("aria-busy", String(active));
  setText("#run-id", run.run_id);
  setText("#run-phase", run.phase || "Accepted");
  setText("#run-elapsed", `Elapsed ${Math.max(0, Math.round((run.elapsed_ms || 0) / 1000))}s`);
  setText("#attempt-label", `Bounded retries: ${run.attempts || 0} / 2`);
  renderProgress(run);
  if (run.state === "needs_input") {
    resetStatePanels();
    show(clarifySection, true);
    renderClarification(run);
    updateJourney("clarify");
    return;
  }
  if (run.state === "succeeded" && run.result) {
    resetStatePanels();
    show(resultSection, true);
    renderResult(run.result);
    updateJourney("decision");
    return;
  }
  if (["failed", "expired", "canceled"].includes(run.state)) {
    resetStatePanels();
    show(recoverySection, true);
    renderRecovery(run);
    updateJourney("evidence");
    return;
  }
  resetStatePanels();
  show(runSection, true);
  updateJourney("run");
  $("#cancel-run").disabled = run.state === "cancel_requested";
}

function renderProgress(run) {
  const list = $("#progress-list");
  list.replaceChildren();
  const stateIndex = { accepted: 0, queued: 1, planning: 2, resolving_asset: 3, evidence_pending: 4, evidence_partial: 7, composing: 7, validating: 8, succeeded: 8 }[run.state];
  progressLabels.forEach((label, index) => {
    const item = document.createElement("li");
    item.textContent = label;
    if (stateIndex != null && index < stateIndex) item.className = "is-done";
    if (stateIndex === index && !["succeeded", "failed", "canceled"].includes(run.state)) item.className = "is-current";
    list.append(item);
  });
  if (run.state === "evidence_partial") {
    const item = document.createElement("li");
    item.className = "is-current";
    item.textContent = "Partial evidence is visible";
    list.append(item);
  }
}

function renderClarification(run) {
  setText("#clarify-question", run.clarification?.question || "Choose one matching demo asset.");
  const list = $("#candidate-list");
  list.replaceChildren();
  for (const candidate of run.clarification?.candidates || []) {
    const card = document.createElement("div");
    card.className = "candidate-card";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = candidate.display_name;
    const detail = document.createElement("small");
    detail.textContent = `${candidate.workspace} · observed ${new Date(candidate.last_observed_at).toLocaleDateString()}`;
    text.append(name, detail);
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = "Assess this asset →";
    button.addEventListener("click", () => clarifyRun(run.run_id, candidate.candidate_id, button));
    card.append(text, button);
    list.append(card);
  }
}

async function clarifyRun(runId, candidateId, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}/clarify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: candidateId }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Clarification could not be submitted");
    currentRun = data;
    sessionStorage.setItem("gemini-agents-run-id", data.run_id);
    renderRun(data);
    subscribe(data.run_id);
  } catch (error) {
    setText("#clarify-question", error.message);
    button.disabled = false;
  }
}

function renderResult(result) {
  const decision = result.decision.toLowerCase();
  const mark = result.decision === "READY" ? "✓" : result.decision === "REVIEW" ? "!" : result.decision === "UNKNOWN" ? "?" : "×";
  const card = $("#decision-card");
  card.replaceChildren();
  const icon = document.createElement("span");
  icon.className = `decision-mark ${decision}`;
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = mark;
  const copy = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = result.headline;
  const summary = document.createElement("p");
  summary.textContent = result.summary;
  copy.append(heading, summary);
  card.append(icon, copy);
  const resolved = $("#resolved-asset");
  if (result.resolved_asset) {
    resolved.hidden = false;
    resolved.textContent = `Resolved asset: ${result.resolved_asset.display_name} · ${result.resolved_asset.workspace}`;
  } else {
    resolved.hidden = true;
    resolved.textContent = "";
  }
  setText("#result-limitations", `${result.policy_disclosure || "Recommended demo policy proposal."} ${result.limitations?.join(" ") || "Demo evidence is synthetic and this is not an approval."}`);
  renderChecks(result);
  const recommendations = $("#recommendations-list");
  recommendations.replaceChildren();
  for (const recommendation of result.recommendations || []) {
    const item = document.createElement("li");
    item.textContent = recommendation;
    recommendations.append(item);
  }
  setText("#policy-version", `Policy ${result.policy_version}`);
  setText("#result-provenance", result.provenance?.label || "Deterministic mock / Demo evidence");
}

function renderChecks(result) {
  const checks = $("#checks-list");
  const gaps = $("#gaps-list");
  checks.replaceChildren();
  gaps.replaceChildren();
  for (const check of result.checks || []) {
    const target = check.status === "complete" ? checks : gaps;
    const card = document.createElement("div");
    card.className = check.status === "complete" ? "check-card" : "gap-card";
    const copy = document.createElement("div");
    const name = document.createElement("span");
    name.className = "check-name";
    name.textContent = titleCase(check.check_kind);
    const status = document.createElement("span");
    status.className = "check-state";
    status.textContent = check.status.replaceAll("_", " ");
    copy.append(name, status);
    card.append(copy);
    if (check.evidence_id) {
      const button = document.createElement("button");
      button.className = "evidence-button";
      button.type = "button";
      button.textContent = "Inspect evidence";
      button.addEventListener("click", () => openEvidence(currentRun.run_id, check.evidence_id));
      card.append(button);
    }
    target.append(card);
  }
  if (!gaps.children.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "No evidence gaps were found in the configured checks.";
    gaps.append(empty);
  }
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderRecovery(run) {
  setText("#recovery-message", run.recovery?.message || "The run did not produce a verified result. Its history is preserved.");
  setText("#recovery-provenance", run.provenance?.label || "Deterministic mock / Demo evidence");
  setText("#recovery-original", `Original run ${run.run_id}`);
  $("#retry-run").disabled = !run.recovery?.recoverable;
}

async function retryRun() {
  if (!currentRun) return;
  const button = $("#retry-run");
  button.disabled = true;
  try {
    const response = await fetch(`/v1/runs/${encodeURIComponent(currentRun.run_id)}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Retry could not be created");
    currentRun = data;
    sessionStorage.setItem("gemini-agents-run-id", data.run_id);
    renderRun(data);
    subscribe(data.run_id);
  } catch (error) {
    setText("#recovery-message", error.message);
    button.disabled = false;
  }
}

async function cancelRun() {
  if (!currentRun) return;
  $("#cancel-run").disabled = true;
  const response = await fetch(`/v1/runs/${encodeURIComponent(currentRun.run_id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.ok) renderRun(await response.json());
}

async function openEvidence(runId, evidenceId) {
  lastFocused = document.activeElement;
  const response = await fetch(`/v1/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}`);
  if (!response.ok) return;
  const evidence = await response.json();
  const content = $("#evidence-content");
  content.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = `${titleCase(evidence.check_kind)} evidence`;
  const table = document.createElement("dl");
  table.className = "evidence-table";
  addField(table, "Status", evidence.status.replaceAll("_", " "));
  addField(table, "Source", evidence.source_label);
  addField(table, "Operation", evidence.semantic_operation);
  addField(table, "Observed", evidence.observed_at);
  addField(table, "Fresh until", evidence.fresh_until);
  addField(table, "Policy", evidence.policy_version);
  const facts = document.createElement("ul");
  facts.className = "fact-list";
  for (const [key, value] of Object.entries(evidence.facts || {})) {
    const item = document.createElement("li");
    const keyNode = document.createElement("span");
    keyNode.textContent = key;
    const valueNode = document.createElement("strong");
    valueNode.textContent = `${value}${evidence.units?.[key] ? ` ${evidence.units[key]}` : ""}`;
    item.append(keyNode, valueNode);
    facts.append(item);
  }
  const factsField = document.createElement("div");
  factsField.className = "evidence-field";
  const factsLabel = document.createElement("dt");
  factsLabel.textContent = "Normalized facts";
  const factsValue = document.createElement("dd");
  factsValue.append(facts);
  factsField.append(factsLabel, factsValue);
  table.append(factsField);
  content.append(heading, table);
  const drawer = $("#evidence-drawer");
  drawer.hidden = false;
  $(".evidence-drawer").focus();
  updateJourney("evidence");
}

function addField(parent, label, value) {
  const field = document.createElement("div");
  field.className = "evidence-field";
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value || "Not provided";
  field.append(dt, dd);
  parent.append(field);
}

function closeEvidence() {
  $("#evidence-drawer").hidden = true;
  if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (validateForm()) submitRun();
});
problem.addEventListener("input", updateCount);
document.querySelectorAll("[data-example]").forEach((button) => button.addEventListener("click", () => applyExample(button.dataset.example)));
$("#cancel-run").addEventListener("click", cancelRun);
$("#retry-run").addEventListener("click", retryRun);
$("#close-evidence").addEventListener("click", closeEvidence);
$("#evidence-drawer").addEventListener("click", (event) => { if (event.target === $("#evidence-drawer")) closeEvidence(); });
document.addEventListener("keydown", (event) => {
  const drawer = $("#evidence-drawer");
  if (drawer.hidden) return;
  if (event.key === "Escape") {
    closeEvidence();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...drawer.querySelectorAll("button, [href], input, textarea, select, [tabindex]:not([tabindex=\"-1\"])")].filter((item) => !item.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const savedRunId = sessionStorage.getItem("gemini-agents-run-id");
if (savedRunId) refreshRun(savedRunId).then(() => { if (currentRun && !terminalStates.has(currentRun.state)) subscribe(savedRunId); });
updateCount();
