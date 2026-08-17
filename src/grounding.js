import {
  MAX_CHUNK_CHARS,
  MAX_SELECTED_CHARS,
  MAX_SELECTED_EXCERPTS,
  citationForChunk,
} from "./documents.js";
import {
  GROUNDED_BRIEF_SCHEMA,
} from "./grounding-contracts.js";
import { ModelGateway } from "./model-gateway.js";
import { containsUnsafeText, normalizeText } from "./contracts.js";

const STOP_WORDS = new Set("a an and are as at be before by can do for from has how in is it me of on or the this to what when where which with you your".split(" "));

export class GroundingSource {
  capabilities() {
    return Object.freeze({
      backend: "abstract",
      source_id: "grounding-source",
      read_only: true,
      external: false,
      operations: ["select_excerpts", "read_citation"],
    });
  }

  async search() {
    throw new Error("GroundingSource.search is not implemented");
  }

  async citation() {
    throw new Error("GroundingSource.citation is not implemented");
  }
}

function termsFor(query) {
  return [...new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].filter((term) => !STOP_WORDS.has(term));
}

export class LocalDeterministicGroundingSource extends GroundingSource {
  constructor({ store } = {}) {
    super();
    if (!store) throw new Error("LocalDeterministicGroundingSource requires a store");
    this.store = store;
    this.manifest = Object.freeze({
      backend: "local",
      source_id: "local-deterministic-grounding",
      version: "local-grounding@1",
      read_only: true,
      external: false,
      operations: ["select_excerpts", "read_citation"],
      future_adapters: ["vertex_ai_search", "bigquery_vector_search"],
    });
  }

  capabilities() {
    return this.manifest;
  }

  async search(documentId, query, { limit = MAX_SELECTED_EXCERPTS, maxChars = MAX_SELECTED_CHARS } = {}) {
    const document = this.store.getDocument(documentId);
    if (!document) return { status: "missing", excerpts: [], source: this.manifest };
    const terms = termsFor(query);
    if (!terms.length) return { status: "gap", excerpts: [], source: this.manifest };
    const ranked = document.chunks
      .map((chunk) => {
        const haystack = chunk.excerpt.toLocaleLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { chunk, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
      .slice(0, Math.max(1, Math.min(MAX_SELECTED_EXCERPTS, limit)));
    const excerpts = [];
    let used = 0;
    for (const item of ranked) {
      if (used >= maxChars) break;
      const remaining = maxChars - used;
      const excerpt = item.chunk.excerpt.slice(0, Math.min(MAX_CHUNK_CHARS, remaining));
      if (!excerpt) continue;
      const citation = citationForChunk(document, item.chunk);
      excerpts.push({
        citation_id: citation.citation_id,
        chunk_id: item.chunk.chunk_id,
        text: excerpt,
        source_locations: item.chunk.source_locations,
        score: item.score,
      });
      used += excerpt.length;
    }
    return { status: excerpts.length ? "selected" : "gap", excerpts, source: this.manifest };
  }

  async citation(documentId, citationId) {
    const document = this.store.getDocument(documentId);
    if (!document) return undefined;
    for (const chunk of document.chunks) {
      const citation = citationForChunk(document, chunk);
      if (citation.citation_id === citationId) return citation;
    }
    return undefined;
  }
}

export function groundedPromptInput(question, excerpts) {
  let used = 0;
  const selected = [];
  for (const excerpt of excerpts.slice(0, MAX_SELECTED_EXCERPTS)) {
    const text = String(excerpt.text || "").slice(0, Math.min(MAX_CHUNK_CHARS, MAX_SELECTED_CHARS - used));
    if (!text) continue;
    selected.push({
      citation_id: excerpt.citation_id,
      text,
      source_locations: excerpt.source_locations,
    });
    used += text.length;
    if (used >= MAX_SELECTED_CHARS) break;
  }
  return {
    schema_version: GROUNDED_BRIEF_SCHEMA,
    question: normalizeText(question, "question", { min: 1, max: 1_000, required: true }),
    excerpts: selected,
  };
}

function assertGroundedText(value, field) {
  const unavailableMediaClaim = /\b(?:video|audio|image|music|vfx)\b.{0,60}\b(?:generate|generation|available|supported|create|produce)\b|\b(?:generate|generation|available|supported|create|produce)\b.{0,60}\b(?:video|audio|image|music|vfx)\b/i.test(value || "");
  if (typeof value !== "string" || value.length < 1 || value.length > (field === "title" ? 180 : 1_000) || containsUnsafeText(value) || unavailableMediaClaim) {
    throw new Error(`Grounded proposal ${field} is unsafe or unbounded`);
  }
}

export function validateGroundedBriefProposal(value, knownCitationIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grounded proposal must be an object");
  const allowed = new Set(["schema_version", "title", "summary", "key_points", "cited_citation_ids"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Grounded proposal contains unknown field: ${key}`);
  if (value.schema_version !== GROUNDED_BRIEF_SCHEMA) throw new Error(`Grounded proposal schema must be ${GROUNDED_BRIEF_SCHEMA}`);
  assertGroundedText(value.title, "title");
  assertGroundedText(value.summary, "summary");
  if (!Array.isArray(value.key_points) || value.key_points.length > MAX_SELECTED_EXCERPTS) throw new Error("Grounded proposal key_points are invalid");
  if (!Array.isArray(value.cited_citation_ids) || value.cited_citation_ids.length > MAX_SELECTED_EXCERPTS) throw new Error("Grounded proposal citations are invalid");
  const ids = new Set(knownCitationIds);
  const cited = new Set(value.cited_citation_ids);
  if (ids.size > 0 && cited.size < 1) throw new Error("Grounded proposal must cite a selected source excerpt");
  for (const citationId of cited) if (!ids.has(citationId)) throw new Error("Grounded proposal cited an unknown citation");
  for (const point of value.key_points) {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Grounded proposal key point is invalid");
    const pointKeys = Object.keys(point);
    if (pointKeys.some((key) => key !== "text" && key !== "citation_ids")) throw new Error("Grounded proposal key point contains an unknown field");
    assertGroundedText(point.text, "key point");
    if (!Array.isArray(point.citation_ids) || point.citation_ids.length < 1 || point.citation_ids.length > MAX_SELECTED_EXCERPTS) throw new Error("Grounded proposal key point citations are invalid");
    for (const citationId of point.citation_ids) {
      if (!ids.has(citationId)) throw new Error("Grounded proposal key point cited an unknown citation");
      if (!cited.has(citationId)) throw new Error("Grounded proposal key point citation is missing from cited_citation_ids");
    }
  }
  if (cited.size > MAX_SELECTED_EXCERPTS) throw new Error("Grounded proposal cited too many excerpts");
  return value;
}

export function deterministicGroundedBriefProposal(input) {
  const excerpts = input.excerpts || [];
  const citationIds = excerpts.map((excerpt) => excerpt.citation_id).slice(0, MAX_SELECTED_EXCERPTS);
  return {
    schema_version: GROUNDED_BRIEF_SCHEMA,
    title: "Grounded script brief",
    summary: `This brief uses ${citationIds.length} selected source excerpt${citationIds.length === 1 ? "" : "s"}. The statements below are limited to the uploaded source text.`,
    key_points: excerpts.slice(0, MAX_SELECTED_EXCERPTS).map((excerpt) => ({ text: excerpt.text, citation_ids: [excerpt.citation_id] })),
    cited_citation_ids: citationIds,
  };
}

export class GroundedBriefModel extends ModelGateway {
  provenance() {
    return { backend: "fake", model_id: null, location: null, api_version: null, prompt_id: "grounded-script-brief@1", prompt_hash: null, schema_version: GROUNDED_BRIEF_SCHEMA, schema_hash: null, generation_config_hash: null };
  }

  async groundedBrief(input) {
    return deterministicGroundedBriefProposal(input);
  }
}
