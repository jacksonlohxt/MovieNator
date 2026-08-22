import {
  MAX_SELECTED_EXCERPTS,
  safeCitationProjection,
} from "./documents.js";
import {
  deterministicGroundedBriefProposal,
  deterministicScriptBriefProposal,
  groundedPromptInput,
  validateGroundedBriefProposal,
  validateScriptBriefProposal,
} from "./grounding.js";
import { SCRIPT_BRIEF_RESULT_SCHEMA } from "./grounding-contracts.js";
import { combineProvenance, hashValue } from "./contracts.js";

const TERMINAL_SCRIPT_STATES = new Set(["succeeded", "grounding_gap", "failed", "canceled"]);

function sourceProvenance(source, operation = "condense_whole_document") {
  return {
    backend: source?.backend || "local",
    provider_id: source?.source_id || "local-deterministic-grounding",
    manifest_hash: `sha256:${hashValue(source || "local-deterministic-grounding")}`,
    semantic_operation: operation,
  };
}

function modelProvenance(model) {
  return typeof model?.provenance === "function" ? model.provenance("grounded_brief") : { backend: "fake", prompt_id: "movie-inator-script-brief@2" };
}

function resultProvenance(model, source, operation = "condense_whole_document") {
  const modelBackend = modelProvenance(model);
  const groundingBackend = sourceProvenance(source, operation);
  const modelName = modelBackend.backend === "google_rest" ? "Gemini-backed" : "Deterministic mock";
  return {
    ...combineProvenance({ modelBackend, providerBackend: groundingBackend }),
    provider: "Movie-Inator uploaded script source",
    label: `${modelName} / Movie-Inator uploaded script source`,
    grounding_source: groundingBackend,
  };
}

function gapResult(run, reason, source) {
  if (run.brief_version >= 2) {
    return {
      schema_version: SCRIPT_BRIEF_RESULT_SCHEMA,
      workflow: "script_brief",
      status: "grounding_gap",
      brief_run_id: run.run_id,
      document_id: run.document_id,
      title: "Script Brief unavailable",
      logline: { text: "The source could not be read well enough to create a brief.", citation_ids: [] },
      synopsis: { text: "No grounded source excerpts were available.", citation_ids: [] },
      main_characters: [],
      setting_tone_themes: { setting: "Not established.", tone: "Not established.", themes: [], citation_ids: [] },
      production_details: [],
      open_questions: [{ question: "Upload a readable PDF or text script and try again.", citation_ids: [] }],
      cited_citation_ids: [],
      citations: [],
      grounding: { source: "local", strategy: "whole_document_condensation", selected_excerpt_count: 0, gap: true, reason },
      provenance: resultProvenance(run.model, source, "condense_whole_document"),
      limitations: ["The source did not provide readable excerpts for a safe brief.", "Citations do not grant rights, approval, or permission to publish."],
    };
  }
  return {
    schema_version: "grounded-script-result@1",
    workflow: "grounded_script_brief",
    status: "grounding_gap",
    brief_run_id: run.run_id,
    document_id: run.document_id,
    title: "No grounded excerpts found",
    summary: "Movie-Inator could not find a bounded source excerpt matching this question. The brief does not infer an answer from the full document.",
    key_points: [],
    cited_citation_ids: [],
    citations: [],
    grounding: { source: "local", selected_excerpt_count: 0, gap: true, reason },
    provenance: resultProvenance(run.model, source, "select_excerpts"),
    limitations: ["No grounded source excerpt was selected.", "This workflow does not create video, audio, image, music, or VFX output."],
  };
}

export function projectGroundedRun(run, store) {
  if (!run) return undefined;
  const events = store.getScriptEvents(run.run_id);
  const terminal = TERMINAL_SCRIPT_STATES.has(run.state);
  return {
    schema_version: "grounded-brief-projection@1",
    run_id: run.run_id,
    workflow: run.workflow,
    document_id: run.document_id,
    state: run.state,
    phase: run.phase,
    status: run.result?.status || (run.state === "failed" ? "RECOVERY" : terminal ? "GROUNDING_GAP" : "RUNNING"),
    created_at: run.created_at,
    updated_at: run.updated_at,
    last_event_seq: events.at(-1)?.seq || 0,
    progress: run.progress,
    result: run.result,
    provenance: run.provenance,
    recovery: run.error ? { recoverable: run.error.recoverable, message: run.error.message, actions: run.error.recoverable ? ["retry"] : [] } : null,
  };
}

export class GroundedBriefEngine {
  constructor({ store, groundingSource, model, audit } = {}) {
    if (!store || !groundingSource || !model) throw new Error("GroundedBriefEngine requires store, groundingSource, and model");
    this.store = store;
    this.groundingSource = groundingSource;
    this.model = model;
    this.audit = audit;
    this.jobs = new Map();
  }

  provenance() {
    return resultProvenance(this.model, this.groundingSource.capabilities());
  }

  enqueue(runId) {
    if (this.jobs.has(runId)) return this.jobs.get(runId);
    const job = Promise.resolve().then(() => this.execute(runId)).catch((error) => {
      const run = this.store.getScriptRun(runId);
      if (run && !TERMINAL_SCRIPT_STATES.has(run.state)) {
        this.store.markScriptFailed(runId, { class: error.code || "grounding_failed", message: "The grounded brief stopped safely before a verified result was available.", recoverable: true });
        this.store.appendScriptEvent(runId, "script.failed", "recovery", "failed", "Grounded brief needs recovery", { recoverable: true });
        this.audit?.record({ type: "request_outcome", outcome: "failed", mode: this.model?.provenance?.().backend || "fake", runId, code: error.code || "grounding_failed", provenance: this.provenance(), attributes: { recoverable: true } });
      }
      return this.store.getScriptRun(runId);
    }).finally(() => this.jobs.delete(runId));
    this.jobs.set(runId, job);
    return job;
  }

  async waitForIdle(runId) {
    const job = this.jobs.get(runId);
    if (job) await job;
    return this.store.getScriptRun(runId);
  }

  async retry(runId, { idempotencyHash } = {}) {
    const run = this.store.getScriptRun(runId);
    if (!run) throw new Error("Grounded brief run not found");
    if (!['failed'].includes(run.state)) throw new Error("Only a failed grounded brief can be retried");
    const child = this.store.createScriptRun({ documentId: run.document_id, question: run.question, requestIntent: run.request_intent || run.question, briefVersion: run.brief_version || 1, idempotencyHash: idempotencyHash || hashValue(`${runId}|retry|${Date.now()}`), parentRunId: runId, retryCount: run.retry_count + 1, provenance: this.provenance() }).run;
    this.enqueue(child.run_id);
    return child;
  }

  async execute(runId) {
    let run = this.store.getScriptRun(runId);
    if (!run || TERMINAL_SCRIPT_STATES.has(run.state)) return run;
    run = this.store.transitionScriptRun(runId, "queued", { phase: "queued", progress: { stage: "queued", selected_excerpt_count: 0 }, provenance: this.provenance() });
    this.store.appendScriptEvent(runId, "script.queued", "queue", "queued", "Grounded brief queued", {});
    this.store.transitionScriptRun(runId, "grounding", { phase: "grounding", progress: { stage: "grounding", selected_excerpt_count: 0 } });
    this.store.appendScriptEvent(runId, "script.grounding_started", "grounding", "grounding", "Selecting bounded source excerpts", { source: this.groundingSource.capabilities().source_id });
    const wholeDocument = run.brief_version >= 2;
    const selected = wholeDocument && typeof this.groundingSource.condense === "function"
      ? await this.groundingSource.condense(run.document_id, run.request_intent || run.question, { limit: MAX_SELECTED_EXCERPTS })
      : await this.groundingSource.search(run.document_id, run.question, { limit: MAX_SELECTED_EXCERPTS });
    if (selected.status !== "selected" || !selected.excerpts.length) {
      const result = gapResult({ ...run, model: this.model }, selected.status || "no_matching_excerpt", selected.source);
      this.store.addScriptResult(runId, result);
      this.store.appendScriptEvent(runId, "script.grounding_gap", "grounding", "grounding_gap", "No matching source excerpt found", { reason: selected.status || "gap" });
      return this.store.getScriptRun(runId);
    }
    const excerpts = selected.excerpts.map((excerpt) => ({ ...excerpt, document_id: run.document_id }));
    this.store.transitionScriptRun(runId, "composing", { phase: "composing", progress: { stage: "composing", selected_excerpt_count: excerpts.length }, citation_ids: excerpts.map((excerpt) => excerpt.citation_id) });
    this.store.appendScriptEvent(runId, "script.composing", "writer", "composing", "Composing a grounded script brief", { selected_excerpt_count: excerpts.length });
    const promptInput = groundedPromptInput(run.request_intent || run.question, excerpts, { wholeDocument, coverage: selected.coverage });
    let proposal;
    try {
      if (typeof this.model.groundedBrief !== "function") throw new Error("Grounded brief model method is unavailable");
      proposal = await this.model.groundedBrief(promptInput, { run_id: runId, stage: "grounded_brief", deadline_at: run.deadline_at, rate_limit_key: "grounded_script_brief" });
      if (wholeDocument) validateScriptBriefProposal(proposal, excerpts.map((excerpt) => excerpt.citation_id));
      else validateGroundedBriefProposal(proposal, excerpts.map((excerpt) => excerpt.citation_id));
    } catch {
      proposal = wholeDocument ? deterministicScriptBriefProposal(promptInput) : deterministicGroundedBriefProposal(promptInput);
      if (wholeDocument) validateScriptBriefProposal(proposal, excerpts.map((excerpt) => excerpt.citation_id));
      else validateGroundedBriefProposal(proposal, excerpts.map((excerpt) => excerpt.citation_id));
      this.store.appendScriptEvent(runId, "script.writer_fallback", "writer", "composing", "Using the deterministic grounded brief template", { reason: "writer_unavailable_or_invalid" });
    }
    this.store.transitionScriptRun(runId, "validating", { phase: "validating", progress: { stage: "validating", selected_excerpt_count: excerpts.length } });
    this.store.appendScriptEvent(runId, "script.verifying", "verifier", "validating", "Checking citation IDs and source mapping", { citation_count: proposal.cited_citation_ids.length });
    const citationById = new Map(excerpts.map((excerpt) => [excerpt.citation_id, excerpt]));
    const citations = proposal.cited_citation_ids.map((citationId) => {
      const excerpt = citationById.get(citationId);
      if (!excerpt) throw new Error("Unknown grounded citation");
      return { citation_id: citationId, document_id: run.document_id, chunk_id: excerpt.chunk_id, source_locations: excerpt.source_locations, source_label: "Movie-Inator uploaded script source" };
    });
    const result = wholeDocument
      ? {
          schema_version: SCRIPT_BRIEF_RESULT_SCHEMA,
          workflow: "script_brief",
          status: "succeeded",
          brief_run_id: runId,
          document_id: run.document_id,
          title: proposal.title,
          summary: proposal.synopsis.text,
          key_points: proposal.main_characters.map((character) => ({ text: character.description, citation_ids: character.citation_ids })),
          logline: proposal.logline,
          synopsis: proposal.synopsis,
          main_characters: proposal.main_characters,
          setting_tone_themes: proposal.setting_tone_themes,
          production_details: proposal.production_details,
          open_questions: proposal.open_questions,
          cited_citation_ids: proposal.cited_citation_ids,
          citations,
          grounding: { source: "local", strategy: "whole_document_condensation", selected_excerpt_count: excerpts.length, source_chunk_count: selected.source_chunk_count || selected.coverage?.source_chunk_count || excerpts.length, source_coverage: selected.coverage, gap: false },
          provenance: resultProvenance(this.model, selected.source, "condense_whole_document"),
          limitations: ["This brief is grounded only in the uploaded source.", "Material statements link to source excerpts; open questions identify what the source does not establish.", "Citations do not grant rights, approval, or permission to publish."],
        }
      : {
          schema_version: "grounded-script-result@1",
          workflow: "grounded_script_brief",
          status: "succeeded",
          brief_run_id: runId,
          document_id: run.document_id,
          title: proposal.title,
          summary: proposal.summary,
          key_points: proposal.key_points,
          cited_citation_ids: proposal.cited_citation_ids,
          citations,
          grounding: { source: "local", selected_excerpt_count: excerpts.length, gap: false },
          provenance: resultProvenance(this.model, selected.source, "select_excerpts"),
          limitations: ["This brief is grounded only in selected excerpts from the uploaded source.", "Citations open source excerpts and do not grant rights or approval.", "Video, audio, image, music, and VFX generation are separate future adapters and are not available here."],
        };
    this.store.addScriptResult(runId, result);
    this.store.appendScriptEvent(runId, "script.succeeded", "projection", "succeeded", "Grounded script brief ready", { citation_count: citations.length });
    this.audit?.record({ type: "request_outcome", outcome: "succeeded", mode: result.provenance.model_backend.backend, runId, provenance: result.provenance, attributes: { workflow: result.workflow, citation_count: citations.length } });
    return this.store.getScriptRun(runId);
  }
}

export function safeScriptCitation(citation) {
  return safeCitationProjection(citation);
}
