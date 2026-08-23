import {
  LEGACY_SESSION_KEYS,
  SESSION_KEYS,
  modelResultStatus,
  partnerStatusFromProjection,
  readMigratedSessionValue,
  runtimeStatusFromReadiness,
  writeSessionValue,
} from "./session-state.js";

const DEFAULT_SCRIPT_BRIEF_REQUEST = "Create a concise filmmaker-facing brief with the story essentials, key characters, setting, tone, themes, useful production details, and any open questions or gaps.";

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
const groundingFailure = $("#grounding-failure");
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
const groundingFallbackRuns = new Set();
const readinessFallbackRuns = new Set();
let runtimeStatus = { state: "not-yet-checked" };

function setText(selector, value) {
  const element = typeof selector === "string" ? $(selector) : selector;
  if (element) element.textContent = value == null ? "" : String(value);
  return element;
}

function show(element, visible = true) {
  if (element) element.hidden = !visible;
}

function renderRuntimeStatus(status) {
  runtimeStatus = status;
  setText("#runtime-mode-label", status.label);
  setText("#runtime-trust-label", status.trustLabel);
  setText("#runtime-trust-copy", status.trustCopy);
  setText("#runtime-disclosure", status.disclosure);
  setText("#grounding-runtime-label", status.label);
  setText("#grounding-runtime-copy", status.trustCopy);
  const dot = $("#runtime-mode-dot");
  if (dot) {
    dot.classList.remove("mode-dot-pending", "mode-dot-mock", "mode-dot-live", "mode-dot-unavailable");
    dot.classList.add(status.state === "mock" ? "mode-dot-mock" : status.state === "live-gemini" ? "mode-dot-live" : status.state === "unavailable" ? "mode-dot-unavailable" : "mode-dot-pending");
  }
  const icon = $("#runtime-trust-icon");
  if (icon) icon.textContent = status.state === "mock" ? "✓" : status.state === "live-gemini" ? "◆" : status.state === "unavailable" ? "!" : "◌";
}

function renderPartnerStatus(projection, options = {}) {
  const element = $("#partner-status");
  if (!element) return;
  const status = partnerStatusFromProjection(projection, options);
  element.classList.toggle("is-ready", status.state === "ready");
  element.classList.toggle("is-unavailable", status.state === "unavailable");
  element.textContent = `${status.label}: ${status.detail}`;
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
    setText("#hero-copy", "Ask one focused question about one audience asset. MovieNator gathers bounded demo evidence, applies a deterministic policy, and shows what a person should check next.");
    resetStatePanels();
    show(askSection, true);
    if (currentRun) renderRun(currentRun);
    updateJourney(currentRun?.state === "succeeded" ? "decision" : "ask");
  } else {
    setText("#hero-eyebrow", "Filmmaker Script Brief");
    setText("#page-title", "Turn your script into a useful brief.");
    setText("#hero-copy", "Upload a script, tell us what you need, and get the story essentials in one clear place. Start with the default brief or ask for a specific focus.");
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
    if (payload.type === "writer.fallback") readinessFallbackRuns.add(payload.run_id);
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
  renderFoundation(run);
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

function renderFoundation(run) {
  const checkpoint = run.checkpoints?.at(-1);
  setText("#checkpoint-status", checkpoint ? `${checkpoint.kind} · ${checkpoint.status} · ${run.checkpoints.length} saved` : "No checkpoint yet");
  const branches = run.branches || [];
  const completed = branches.filter((branch) => ["succeeded", "failed", "timed_out", "canceled", "skipped"].includes(branch.state)).length;
  setText("#branch-status", branches.length ? `${completed} / ${branches.length} terminal` : "Pending");
  setText("#workflow-outcome-status", run.workflow_state?.terminal_outcome?.outcome ? `${run.workflow_state.terminal_outcome.outcome} · history preserved` : run.workflow_state?.cancellation?.requested ? "Cancellation recorded" : "Run is resumable");
}

async function loadToolReadiness() {
  try {
    const response = await fetch("/v1/tools/readiness", { headers: { accept: "application/json" } });
    const readiness = await response.json();
    const ready = readiness.no_side_effect_mode && readiness.tools?.every((tool) => tool.state === "ready" && tool.credentials === "none");
    setText("#tool-readiness-label", ready ? "Ready" : "Unavailable");
    setText("#tool-mode-status", ready ? "Local mock, read-only" : "Safe unavailable");
  } catch {
    setText("#tool-readiness-label", "Unavailable");
    setText("#tool-mode-status", "Safe unavailable");
  }
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
  const modelBackend = result.provenance?.model_backend?.backend;
  setText("#result-model-status", modelResultStatus({ backend: modelBackend, fallback: readinessFallbackRuns.has(currentRun?.run_id) }).copy);
  setText("#result-limitations", `${result.policy_disclosure || "The API did not provide a policy disclosure."} ${result.limitations?.join(" ") || "No additional limitations were provided by the API."}`);
  renderChecks(result);
  const recommendations = $("#recommendations-list");
  recommendations.replaceChildren();
  for (const recommendation of result.recommendations || []) {
    const item = document.createElement("li");
    item.textContent = recommendation;
    recommendations.append(item);
  }
  setText("#policy-version", `Policy ${result.policy_version}`);
  setText("#result-provenance", result.provenance?.label || (modelBackend === "google_rest" ? "Live model provenance was not provided by the API" : "Mock result provenance was not provided by the API"));
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
  setText("#recovery-provenance", run.provenance?.label || "Result provenance was not provided by the API");
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
  show(groundingFailure, false);
  setText("#document-progress-title", "Reading your source");
  setText("#document-progress-detail", "Uploading the script and mapping its page or section locations.");
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
    setText("#document-progress-title", data.duplicate ? "Source already ready" : "Source ready");
    setText("#document-progress-detail", `${data.text_char_count.toLocaleString()} characters read across ${data.chunk_count} source sections. Tell us what would be useful.`);
    documentSummary.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = `${data.filename} · ${data.media_type} · ${data.text_char_count.toLocaleString()} characters read · ${data.truncated ? "source bounded to the upload limit" : "whole source ready"}`;
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
    // An empty request intentionally selects the server-owned default brief.
    groundingQuestion.value = DEFAULT_SCRIPT_BRIEF_REQUEST;
  }
  show(groundingRun, true);
  show(groundingFailure, false);
  show(groundingResult, false);
  $("#submit-grounding").disabled = true;
  try {
    const request = groundingQuestion.value.trim();
    const response = await fetch(`/v1/documents/${encodeURIComponent(currentDocument.document_id)}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ schema_version: "grounded-brief-request@2", ...(request ? { request } : {}) }) });
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
        if (payload.type === "script.writer_fallback") groundingFallbackRuns.add(runId);
        setText("#document-progress-detail", "Your brief is being prepared and its source links are being checked.");
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

function renderGroundingFailure(run) {
  show(groundingResult, false);
  groundingFailure.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = runtimeStatus.state === "live-gemini" ? "The live model did not provide a verified brief" : "No verified brief was returned";
  const message = document.createElement("p");
  message.textContent = runtimeStatus.state === "live-gemini"
    ? "The API did not provide a usable result, so no brief is shown. Your source remains safe and a retry creates a separate attempt."
    : "The API did not provide a usable result. Your source remains safe and a retry creates a separate attempt.";
  const retry = document.createElement("button");
  retry.className = "button button-secondary";
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => retryGroundedBrief(run.run_id, retry));
  groundingFailure.append(heading, message, retry);
  show(groundingFailure, true);
}

function renderGroundingModelStatus(result) {
  const element = $("#grounding-model-status");
  if (!element) return;
  if (result.status === "grounding_gap") {
    element.textContent = "No model output is claimed because the source gap stopped the brief.";
    return;
  }
  const backend = result.provenance?.model_backend?.backend;
  element.textContent = modelResultStatus({ backend, fallback: groundingFallbackRuns.has(currentGroundingRun?.run_id) }).copy;
}

function renderGroundingRun(run) {
  show(groundingRun, true);
  show(groundingFailure, false);
  const userPhase = { accepted: "Preparing your brief", queued: "Reading your source", grounding: "Reading your source", composing: "Preparing your brief", validating: "Checking source links", succeeded: "Ready", grounding_gap: "Source gap", failed: "We need to try again" }[run.state] || "Preparing your brief";
  setText("#grounding-phase", userPhase);
  const labels = ["Preparing your brief", "Reading your source", "Preparing your brief", "Checking source links", "Ready"];
  const stateIndex = { accepted: 0, queued: 1, grounding: 1, composing: 2, validating: 3, succeeded: 4, grounding_gap: 4, failed: 4 }[run.state];
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
    renderGroundingFailure(run);
  }
}

function appendCitedText(parent, text, citationIds = []) {
  const copy = document.createElement("p");
  copy.textContent = text || "Not established in the source.";
  parent.append(copy);
  if (citationIds.length) {
    const links = document.createElement("div");
    links.className = "brief-citations";
    for (const citationId of citationIds) {
      const button = document.createElement("button");
      button.className = "evidence-button";
      button.type = "button";
      button.textContent = `Source ${citationId.slice(-8)}`;
      button.addEventListener("click", () => openGroundingCitation(currentDocument.document_id, citationId));
      links.append(button);
    }
    parent.append(links);
  }
}

function renderBriefList(selector, items, emptyText, renderItem) {
  const list = $(selector);
  list.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  items.forEach((item) => list.append(renderItem(item)));
}

function briefText(result) {
  const lines = [
    `Logline\n${result.logline?.text || result.summary || "Not established in the source."}`,
    `Synopsis\n${result.synopsis?.text || result.summary || "Not established in the source."}`,
    "Main characters",
    ...(result.main_characters || []).map((character) => `${character.name}: ${character.description}`),
    "Setting, tone and themes",
    `Setting: ${result.setting_tone_themes?.setting || "Not established."}`,
    `Tone: ${result.setting_tone_themes?.tone || "Not established."}`,
    `Themes: ${result.setting_tone_themes?.themes?.join(", ") || "Not established."}`,
    "Useful production details",
    ...(result.production_details || []).map((detail) => `${detail.label}: ${detail.value}`),
    "Producer intelligence",
    ...(result.producer_intelligence?.scene_breakdown || []).map((scene) => `${scene.scene_heading} | ${scene.location_wording} | ${scene.int_ext} | ${scene.time_of_day}`),
    ...(result.producer_intelligence?.cast_and_role_demands || []).map((item) => `${item.role}: ${item.demand}`),
    ...(result.producer_intelligence?.production_signals || []).map((item) => `${item.category}: ${item.value}`),
    ...(result.producer_intelligence?.production_risks || []).map((item) => `Risk: ${item.risk}`),
    ...(result.producer_intelligence?.gaps_and_questions || []).map((item) => `Question: ${item.question}`),
    "Open questions and gaps",
    ...(result.open_questions || []).map((item) => item.question),
  ];
  return lines.join("\n\n");
}

function renderGroundingResult(result) {
  setText("#grounding-result-title", result.title || "Script Brief");
  const logline = $("#grounding-logline");
  logline.replaceChildren();
  appendCitedText(logline, result.logline?.text || result.summary, result.logline?.citation_ids || result.cited_citation_ids || []);
  const synopsis = $("#grounding-synopsis");
  synopsis.replaceChildren();
  appendCitedText(synopsis, result.synopsis?.text || result.summary || "No grounded synopsis was published.", result.synopsis?.citation_ids || result.cited_citation_ids || []);
  renderBriefList("#grounding-characters", result.main_characters, "No principal characters were established clearly in the source.", (character) => {
    const card = document.createElement("div");
    card.className = "brief-card";
    const heading = document.createElement("strong");
    heading.textContent = character.name;
    card.append(heading);
    appendCitedText(card, character.description, character.citation_ids);
    return card;
  });
  const setting = $("#grounding-setting");
  setting.replaceChildren();
  const settingData = result.setting_tone_themes;
  if (settingData) {
    for (const [label, value] of [["Setting", settingData.setting], ["Tone", settingData.tone], ["Themes", settingData.themes?.join(", ") || "Not stated clearly in the source."]]) {
      const row = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = label;
      row.append(name);
      appendCitedText(row, value, settingData.citation_ids || []);
      setting.append(row);
    }
  }
  renderBriefList("#grounding-production", result.production_details, "No additional production details were established clearly in the source.", (detail) => {
    const card = document.createElement("div");
    card.className = "brief-card";
    const heading = document.createElement("strong");
    heading.textContent = detail.label;
    card.append(heading);
    appendCitedText(card, detail.value, detail.citation_ids);
    return card;
  });
  const producer = result.producer_intelligence;
  const producerItems = [];
  for (const scene of producer?.scene_breakdown || []) producerItems.push({ label: "Scene", value: `${scene.scene_heading} | Location: ${scene.location_wording} | ${scene.int_ext} | ${scene.time_of_day}`, citation_ids: scene.citation_ids });
  for (const item of producer?.cast_and_role_demands || []) producerItems.push({ label: `Cast: ${item.role}`, value: item.demand, citation_ids: item.citation_ids });
  for (const item of producer?.production_signals || []) producerItems.push({ label: item.category, value: item.value, citation_ids: item.citation_ids });
  for (const item of producer?.production_risks || []) producerItems.push({ label: "Production risk", value: item.risk, citation_ids: item.citation_ids });
  for (const item of producer?.gaps_and_questions || []) producerItems.push({ label: `Open ${item.category} question`, value: item.question, citation_ids: item.citation_ids });
  renderBriefList("#grounding-producer", producerItems, "No producer intelligence was established clearly in the source.", (item) => {
    const card = document.createElement("div");
    card.className = "brief-card";
    const heading = document.createElement("strong");
    heading.textContent = item.label;
    card.append(heading);
    appendCitedText(card, item.value, item.citation_ids);
    return card;
  });
  renderBriefList("#grounding-questions", result.open_questions, "No open questions were flagged.", (item) => {
    const card = document.createElement("div");
    card.className = "brief-card question-card";
    appendCitedText(card, item.question, item.citation_ids);
    return card;
  });
  const citations = $("#grounding-citations");
  citations.replaceChildren();
  for (const citation of result.citations || []) {
    const button = document.createElement("button");
    button.className = "citation-card";
    button.type = "button";
    button.textContent = `${citation.source_locations?.map((location) => location.page ? `Page ${location.page}` : location.section || "Source section").join(", ") || "Source"} · ${citation.citation_id.slice(-8)}`;
    button.addEventListener("click", () => openGroundingCitation(citation.document_id, citation.citation_id));
    citations.append(button);
  }
  if (!citations.children.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = "No source citations were created because the source could not be read safely.";
    citations.append(empty);
  }
  renderGroundingModelStatus(result);
  setText("#grounding-limitations", (result.limitations || []).join(" "));
  $("#copy-brief").dataset.brief = briefText(result);
  setText("#copy-status", "");
}

async function copyBrief() {
  const value = $("#copy-brief").dataset.brief || "";
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    document.body.append(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  setText("#copy-status", "Copied");
}

async function openGroundingCitation(documentId, citationId) {
  lastFocused = document.activeElement;
  const response = await fetch(`/v1/documents/${encodeURIComponent(documentId)}/citations/${encodeURIComponent(citationId)}`);
  if (!response.ok) return;
  const citation = await response.json();
  const content = $("#evidence-content");
  content.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "MovieNator source excerpt";
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
  writeSessionValue(sessionStorage, SESSION_KEYS.groundingRun, data.run_id);
  renderGroundingRun(data);
  subscribeGrounded(data.run_id);
}

async function restoreGroundingSession() {
  const savedDocumentId = readMigratedSessionValue(sessionStorage, SESSION_KEYS.groundingDocument, LEGACY_SESSION_KEYS.groundingDocument);
  if (savedDocumentId) {
    try {
      const response = await fetch(`/v1/documents/${encodeURIComponent(savedDocumentId)}`);
      if (response.ok) {
        currentDocument = await response.json();
        const summary = document.createElement("p");
        summary.textContent = `${currentDocument.filename} · ${currentDocument.text_char_count.toLocaleString()} characters read · whole source ready`;
        documentSummary.replaceChildren(summary);
        show(documentSummary, true);
        show(groundingForm, true);
      }
    } catch {
      // A stale browser reference does not block a new upload.
    }
  }
  const savedRunId = readMigratedSessionValue(sessionStorage, SESSION_KEYS.groundingRun, LEGACY_SESSION_KEYS.groundingRun);
  if (!savedRunId) return;
  try {
    await refreshGroundedRun(savedRunId);
    if (currentGroundingRun) {
      // Replay the bounded redacted event stream for terminal runs so a
      // fallback remains truthful after a browser refresh.
      groundingLastEventSeq = groundingTerminalStates.has(currentGroundingRun.state) ? 0 : currentGroundingRun.last_event_seq || 0;
      subscribeGrounded(savedRunId);
    }
  } catch {
    // A stale browser reference does not block a new brief.
  }
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
$("#copy-brief").addEventListener("click", copyBrief);
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

setWorkflow("grounding");
loadToolReadiness();
restoreGroundingSession();
const savedRunId = readMigratedSessionValue(sessionStorage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun);
if (savedRunId) refreshRun(savedRunId).then(() => {
  if (!currentRun) return;
  lastEventSeq = terminalStates.has(currentRun.state) ? 0 : currentRun.last_event_seq || 0;
  subscribe(savedRunId);
});
updateCount();

async function loadRuntimeReadiness() {
  try {
    const response = await fetch("/readyz", { headers: { accept: "application/json" } });
    let projection;
    try {
      projection = await response.json();
    } catch {
      projection = null;
    }
    renderRuntimeStatus(runtimeStatusFromReadiness(projection, { httpStatus: response.status }));
  } catch {
    renderRuntimeStatus(runtimeStatusFromReadiness({}, { httpStatus: 503 }));
  }
}

async function loadPartnerStatus() {
  try {
    const response = await fetch("/v1/partners", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    renderPartnerStatus(data.providers?.[0]);
  } catch {
    renderPartnerStatus(null, { requestFailed: true });
  }
}

loadRuntimeReadiness();
loadPartnerStatus();
