import { LEGACY_SESSION_KEYS, SESSION_KEYS, readMigratedSessionValue, writeSessionValue } from "./session-state.js";

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
const groundingSection = $("#grounding-section");
const documentForm = $("#document-form");
const scriptFile = $("#script-file");
const documentError = $("#document-error");
const documentProgress = $("#document-progress");
const documentSummary = $("#document-summary");
const groundingForm = $("#grounding-form");
const groundingQuestion = $("#grounding-question");
const groundingError = $("#grounding-error");
const groundingRun = $("#grounding-run");
const groundingResult = $("#grounding-result");
const groundingEventNames = ["script.accepted", "script.queued", "script.grounding_started", "script.grounding_gap", "script.composing", "script.writer_fallback", "script.verifying", "script.succeeded", "script.failed"];
const groundingTerminalStates = new Set(["succeeded", "grounding_gap", "failed", "canceled"]);
const runLive = $("#run-live");
const progressLabels = ["Accepted", "Queued", "Planning", "Resolving asset", "Quality evidence", "Governance evidence", "Lineage evidence", "Composing", "Validating"];
const terminalStates = new Set(["needs_input", "succeeded", "canceled", "expired", "failed"]);
let currentRun = null;
let eventSource = null;
let pollTimer = null;
let reconnectTimer = null;
let lastEventSeq = 0;
let lastFocused = null;
let currentDocument = null;
let currentGroundingRun = null;
let groundingEventSource = null;
let groundingPollTimer = null;
let groundingReconnectTimer = null;
let groundingLastEventSeq = 0;

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

function setWorkflow(mode) {
  document.querySelectorAll("[data-workflow]").forEach((button) => {
    const selected = button.dataset.workflow === mode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-workflow-surface]").forEach((surface) => {
    surface.hidden = surface.dataset.workflowSurface !== mode;
  });
  if (mode === "readiness") {
    setText("#hero-eyebrow", "Audience Data Readiness Brief");
    setText("#page-title", "Know what your launch brief can support.");
    setText("#hero-copy", "Ask one focused question about one audience asset. Movie-Inator gathers bounded demo evidence, applies a deterministic policy, and shows what a person should check next.");
    resetStatePanels();
    show(askSection, true);
    if (currentRun) renderRun(currentRun);
    updateJourney(currentRun?.state === "succeeded" ? "decision" : "ask");
  } else {
    setText("#hero-eyebrow", "Filmmaker script / document grounding");
    setText("#page-title", "Ground a script or document brief.");
    setText("#hero-copy", "Upload a bounded script source, select local excerpts, and inspect every grounded statement at its page or section location. Movie-Inator does not generate media in this workflow.");
  }
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
    writeSessionValue(sessionStorage, SESSION_KEYS.readinessRun, data.run_id);
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
  lastEventSeq = Math.max(lastEventSeq, currentRun?.last_event_seq || 0);
  if ("EventSource" in window) {
    eventSource = new EventSource(`/v1/runs/${encodeURIComponent(runId)}/events?cursor=${encodeURIComponent(lastEventSeq)}`);
    const eventNames = ["run.accepted", "run.queued", "run.planning", "run.resolving_asset", "evidence.started", "evidence.attempt", "evidence.partial", "policy.computed", "writer.started", "writer.fallback", "verifier.started", "run.needs_input", "run.succeeded", "run.failed", "run.cancel_requested", "run.canceled"];
    for (const name of eventNames) eventSource.addEventListener(name, onEvent);
    eventSource.onerror = () => {
      if (eventSource) eventSource.close();
      eventSource = null;
      startPolling(runId);
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; if (currentRun && !terminalStates.has(currentRun.state)) subscribe(runId); }, 1000);
    };
  }
  startPolling(runId);
}

function closeStream() {
  if (eventSource) eventSource.close();
  eventSource = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function startPolling(runId) {
  if (pollTimer) return;
  pollTimer = setInterval(() => refreshRun(runId), 450);
}

function onEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    lastEventSeq = Math.max(lastEventSeq, Number(event.lastEventId || payload.seq || 0));
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
    lastEventSeq = Math.max(lastEventSeq, data.last_event_seq || 0);
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
    const branchKind = label.toLowerCase().replace(" evidence", "");
    const branch = run.progress?.branches?.[branchKind];
    item.textContent = branch ? `${label} - ${branch.status || branch.state}` : label;
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
    writeSessionValue(sessionStorage, SESSION_KEYS.readinessRun, data.run_id);
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
    writeSessionValue(sessionStorage, SESSION_KEYS.readinessRun, data.run_id);
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

async function uploadDocument(event) {
  event.preventDefault();
  documentError.hidden = true;
  const file = scriptFile.files?.[0];
  if (!file) {
    setText(documentError, "Choose a PDF or plain-text script source.");
    documentError.hidden = false;
    scriptFile.focus();
    return;
  }
  if (file.size < 1 || file.size > 5 * 1024 * 1024) {
    setText(documentError, "The source must be between 1 byte and 5 MiB.");
    documentError.hidden = false;
    scriptFile.focus();
    return;
  }
  const formData = new FormData();
  formData.append("file", file, file.name);
  show(documentProgress, true);
  setText("#document-progress-title", "Ingesting source");
  setText("#document-progress-detail", "Uploading, extracting text, mapping source locations, and chunking.");
  show(documentSummary, false);
  show(groundingForm, false);
  show(groundingResult, false);
  $("#upload-document").disabled = true;
  try {
    const response = await fetch("/v1/documents", { method: "POST", body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "The source could not be ingested");
    currentDocument = data;
    writeSessionValue(sessionStorage, SESSION_KEYS.groundingDocument, data.document_id);
    setText("#document-progress-title", data.duplicate ? "Source already ingested" : "Source ready");
    setText("#document-progress-detail", `${data.ingestion?.stages?.join(" · ") || "uploaded · extracted · mapped · ready"}. ${data.chunk_count} bounded chunks mapped.`);
    documentSummary.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = `${data.filename} · ${data.media_type} · ${data.text_char_count.toLocaleString()} extracted characters · ${data.chunk_count} chunks`;
    documentSummary.append(summary);
    show(documentSummary, true);
    show(groundingForm, true);
    groundingQuestion.focus();
  } catch (error) {
    setText(documentError, error.message);
    documentError.hidden = false;
  } finally {
    $("#upload-document").disabled = false;
  }
}

async function submitGrounding(event) {
  event.preventDefault();
  groundingError.hidden = true;
  if (!currentDocument) {
    setText(groundingError, "Upload a source before requesting a grounded brief.");
    groundingError.hidden = false;
    return;
  }
  if (!groundingQuestion.value.trim()) {
    setText(groundingError, "Describe what the source brief should answer.");
    groundingError.hidden = false;
    groundingQuestion.focus();
    return;
  }
  show(groundingRun, true);
  show(groundingResult, false);
  $("#submit-grounding").disabled = true;
  try {
    const response = await fetch(`/v1/documents/${encodeURIComponent(currentDocument.document_id)}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ schema_version: "grounded-brief-request@1", question: groundingQuestion.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "The grounded brief could not be accepted");
    currentGroundingRun = data;
    writeSessionValue(sessionStorage, SESSION_KEYS.groundingRun, data.run_id);
    groundingLastEventSeq = data.last_event_seq || 0;
    renderGroundingRun(data);
    subscribeGrounded(data.run_id);
  } catch (error) {
    setText(groundingError, error.message);
    groundingError.hidden = false;
  } finally {
    $("#submit-grounding").disabled = false;
  }
}

function closeGroundingStream() {
  if (groundingEventSource) groundingEventSource.close();
  groundingEventSource = null;
  if (groundingPollTimer) clearInterval(groundingPollTimer);
  groundingPollTimer = null;
  if (groundingReconnectTimer) clearTimeout(groundingReconnectTimer);
  groundingReconnectTimer = null;
}

function subscribeGrounded(runId) {
  closeGroundingStream();
  if ("EventSource" in window) {
    groundingEventSource = new EventSource(`/v1/script-briefs/${encodeURIComponent(runId)}/events?cursor=${encodeURIComponent(groundingLastEventSeq)}`);
    for (const name of groundingEventNames) groundingEventSource.addEventListener(name, (event) => {
      try {
        const payload = JSON.parse(event.data);
        groundingLastEventSeq = Math.max(groundingLastEventSeq, Number(event.lastEventId || payload.seq || 0));
        setText("#document-progress-detail", payload.display || "Grounding updated");
        refreshGroundedRun(runId);
      } catch {
        refreshGroundedRun(runId);
      }
    });
    groundingEventSource.onerror = () => {
      if (groundingEventSource) groundingEventSource.close();
      groundingEventSource = null;
      startGroundingPolling(runId);
      if (!groundingReconnectTimer) groundingReconnectTimer = setTimeout(() => { groundingReconnectTimer = null; if (currentGroundingRun && !groundingTerminalStates.has(currentGroundingRun.state)) subscribeGrounded(runId); }, 1000);
    };
  }
  startGroundingPolling(runId);
}

function startGroundingPolling(runId) {
  if (groundingPollTimer) return;
  groundingPollTimer = setInterval(() => refreshGroundedRun(runId), 450);
}

async function refreshGroundedRun(runId) {
  if (!runId) return;
  try {
    const response = await fetch(`/v1/script-briefs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new Error("Grounded brief is no longer available");
    const data = await response.json();
    currentGroundingRun = data;
    groundingLastEventSeq = Math.max(groundingLastEventSeq, data.last_event_seq || 0);
    renderGroundingRun(data);
    if (groundingTerminalStates.has(data.state)) closeGroundingStream();
  } catch {
    // Keep the last safe projection visible while polling resumes.
  }
}

function renderGroundingRun(run) {
  show(groundingRun, true);
  setText("#grounding-run-id", run.run_id);
  setText("#grounding-phase", run.phase || "Accepted");
  const labels = ["Accepted", "Queued", "Selecting excerpts", "Composing", "Validating", "Complete"];
  const stateIndex = { accepted: 0, queued: 1, grounding: 2, composing: 3, validating: 4, succeeded: 5, grounding_gap: 5, failed: 5 }[run.state];
  const list = $("#grounding-progress-list");
  list.replaceChildren();
  labels.forEach((label, index) => {
    const item = document.createElement("li");
    item.textContent = label;
    if (stateIndex != null && index < stateIndex) item.className = "is-done";
    if (stateIndex === index && !groundingTerminalStates.has(run.state)) item.className = "is-current";
    list.append(item);
  });
  if (run.result && ["succeeded", "grounding_gap"].includes(run.state)) {
    show(groundingResult, true);
    renderGroundingResult(run.result);
  } else if (run.state === "failed") {
    show(groundingResult, true);
    const result = { title: "Grounded brief needs recovery", summary: run.recovery?.message || "The source was preserved, but no verified brief was published.", key_points: [], citations: [], limitations: ["Retry creates a new child run and preserves the original."] };
    renderGroundingResult(result);
    const retry = document.createElement("button");
    retry.className = "button button-secondary";
    retry.type = "button";
    retry.textContent = "Retry grounded brief";
    retry.addEventListener("click", () => retryGroundedBrief(run.run_id, retry));
    $("#grounding-citations").append(retry);
  }
}

function renderGroundingResult(result) {
  setText("#grounding-result-title", result.title || "Grounded script brief");
  setText("#grounding-result-summary", result.summary || "No grounded summary was published.");
  const points = $("#grounding-points");
  points.replaceChildren();
  for (const point of result.key_points || []) {
    const card = document.createElement("div");
    card.className = "grounding-point";
    const text = document.createElement("p");
    text.textContent = point.text;
    card.append(text);
    for (const citationId of point.citation_ids || []) {
      const button = document.createElement("button");
      button.className = "evidence-button";
      button.type = "button";
      button.textContent = `Open citation ${citationId.slice(-8)}`;
      button.addEventListener("click", () => openGroundingCitation(currentDocument.document_id, citationId));
      card.append(button);
    }
    points.append(card);
  }
  const citations = $("#grounding-citations");
  citations.replaceChildren();
  for (const citation of result.citations || []) {
    const button = document.createElement("button");
    button.className = "citation-card";
    button.type = "button";
    button.textContent = `${citation.citation_id} · ${citation.source_locations?.map((location) => location.page ? `page ${location.page}` : location.section || "source section").join(", ") || "source"}`;
    button.addEventListener("click", () => openGroundingCitation(citation.document_id, citation.citation_id));
    citations.append(button);
  }
  if (!citations.children.length && result.grounding?.gap) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "No citation was created because no source excerpt matched the question.";
    citations.append(empty);
  }
  setText("#grounding-limitations", (result.limitations || []).join(" "));
}

async function openGroundingCitation(documentId, citationId) {
  lastFocused = document.activeElement;
  const response = await fetch(`/v1/documents/${encodeURIComponent(documentId)}/citations/${encodeURIComponent(citationId)}`);
  if (!response.ok) return;
  const citation = await response.json();
  const content = $("#evidence-content");
  content.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "Movie-Inator source excerpt";
  const table = document.createElement("dl");
  table.className = "evidence-table";
  addField(table, "Citation", citation.citation_id);
  addField(table, "Source", citation.source_label);
  addField(table, "Location", citation.source_locations?.map((location) => location.page ? `Page ${location.page}` : `${location.section || "Section"} (lines ${location.line_start}-${location.line_end})`).join(", "));
  const field = document.createElement("div");
  field.className = "evidence-field";
  const label = document.createElement("dt");
  label.textContent = "Bounded source excerpt";
  const excerpt = document.createElement("dd");
  excerpt.className = "source-excerpt";
  excerpt.textContent = citation.excerpt;
  field.append(label, excerpt);
  table.append(field);
  content.append(heading, table);
  $("#evidence-drawer").hidden = false;
  $(".evidence-drawer").focus();
}

async function retryGroundedBrief(runId, button) {
  button.disabled = true;
  const response = await fetch(`/v1/script-briefs/${encodeURIComponent(runId)}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = await response.json();
  if (!response.ok) {
    button.disabled = false;
    return;
  }
  currentGroundingRun = data;
  renderGroundingRun(data);
  subscribeGrounded(data.run_id);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (validateForm()) submitRun();
});
documentForm.addEventListener("submit", uploadDocument);
groundingForm.addEventListener("submit", submitGrounding);
document.querySelectorAll("[data-workflow]").forEach((button) => button.addEventListener("click", () => setWorkflow(button.dataset.workflow)));
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

setWorkflow("readiness");
const savedRunId = readMigratedSessionValue(sessionStorage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun);
if (savedRunId) refreshRun(savedRunId).then(() => { if (currentRun && !terminalStates.has(currentRun.state)) subscribe(savedRunId); });
updateCount();

async function loadPartnerStatus() {
  const status = $("#partner-status");
  if (!status) return;
  try {
    const response = await fetch("/v1/partners", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    const provider = data.providers?.[0];
    const state = provider?.readiness?.state || "unknown";
    status.textContent = `Partner status: ${provider?.provider?.display_name || "not registered"} (${state.replaceAll("_", " ")})`;
  } catch {
    status.textContent = "Partner status: unavailable";
  }
}
loadPartnerStatus();
