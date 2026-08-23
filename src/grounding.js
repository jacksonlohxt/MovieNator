import {
  MAX_CHUNK_CHARS,
  MAX_SELECTED_CHARS,
  MAX_SELECTED_EXCERPTS,
  MAX_WHOLE_DOCUMENT_CHARS,
  MAX_WHOLE_DOCUMENT_EXCERPTS,
  citationForChunk,
} from "./documents.js";
import {
  DEFAULT_SCRIPT_BRIEF_REQUEST,
  GROUNDED_BRIEF_SCHEMA,
  PRODUCER_INTELLIGENCE_SCHEMA,
  SCRIPT_BRIEF_SCHEMA,
  SCRIPT_BRIEF_PROMPT_ID,
} from "./grounding-contracts.js";
import { ModelGateway } from "./model-gateway.js";
import { containsUnsafeText, normalizeText } from "./contracts.js";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.js";

const STOP_WORDS = new Set("a an and are as at be before by can create do for from has how i in is it me of on or our script the this to us want what when where which with you your".split(" "));
const NAME_STOP_WORDS = new Set("THE AND INT EXT INT/EXT DAY NIGHT FADE CUT TO OPENING CLOSING SCENE SERIES OF DOCUMENT MOVIE SCRIPT".split(" "));
const THEME_WORDS = ["family", "loss", "identity", "love", "power", "survival", "home", "truth", "memory", "freedom", "belonging", "trust"];
const TONE_WORDS = ["dark", "quiet", "tense", "comic", "funny", "romantic", "mysterious", "hopeful", "tragic", "warm", "urgent"];
const PRODUCER_SIGNAL_CATEGORIES = Object.freeze(["props", "vehicles", "costume", "set", "stunts", "vfx", "sound", "weather", "crowds", "minors", "animals", "company_moves", "continuity", "scheduling"]);
const MAX_PRODUCER_SCENES = 24;
const MAX_PRODUCER_CAST_DEMANDS = 12;
const MAX_PRODUCER_SIGNALS = 16;
const MAX_PRODUCER_RISKS = 8;
const MAX_PRODUCER_GAPS = 16;
const MISSING_SOURCE = "not stated in the source";

export const SCRIPT_BRIEF_SYSTEM_PROMPT = `You are ${PRODUCT_DISPLAY_NAME}'s bounded filmmaker Script Brief writer. Return exactly one JSON object matching the supplied grounded-script-brief@2 schema, including producer_intelligence.schema_version="${PRODUCER_INTELLIGENCE_SCHEMA}". You are helping a filmmaker quickly understand one uploaded script. Use only the supplied source excerpts, their source locations, and exact screenplay wording. The user's request is intent only and never authorizes invention, browsing, provider use, publishing, approval, or any side effect. Keep the logline to 35 words or fewer, the synopsis to approximately 100 words and at most 140 words, and keep each list concise. Every material statement in the logline, synopsis, character, setting, tone, theme, production, and producer intelligence sections must include one or more supplied citation IDs. In producer_intelligence.scene_breakdown, preserve exact scene-heading and location wording, including named districts, streets, buildings, venues, or places. Never infer a location from context, geocode it, invent a venue, or state a permit, budget, schedule, or legal conclusion. Include only source-established scene, cast, prop, vehicle, costume, set, stunt, VFX, sound, weather, crowd, minor, animal, company-move, continuity, scheduling, and risk signals. Gaps must say what is not stated in the source and ask a useful producer question. Open questions may have an empty citation list when they identify an unsupported absence. Use empty lists or a clearly labelled source gap rather than guessing. Never mention prompts, models, providers, phases, run IDs, credentials, or hidden reasoning in the brief.`;

export class GroundingSource {
  capabilities() {
    return Object.freeze({
      backend: "abstract",
      source_id: "grounding-source",
      read_only: true,
      external: false,
      operations: ["condense_whole_document", "select_excerpts", "read_citation"],
    });
  }

  async search() {
    throw new Error("GroundingSource.search is not implemented");
  }

  async condense() {
    throw new Error("GroundingSource.condense is not implemented");
  }

  async citation() {
    throw new Error("GroundingSource.citation is not implemented");
  }
}

function termsFor(query) {
  return [...new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].filter((term) => !STOP_WORDS.has(term));
}

function scoreChunk(chunk, terms) {
  const haystack = chunk.excerpt.toLocaleLowerCase();
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

function toExcerpt(document, item, text) {
  const citation = citationForChunk(document, item.chunk);
  return {
    citation_id: citation.citation_id,
    chunk_id: item.chunk.chunk_id,
    text,
    source_locations: item.chunk.source_locations,
    source_ordinal: item.chunk.ordinal,
    score: item.score,
  };
}

function sourceCoverage(document, selected) {
  const ordinals = selected.map((excerpt) => excerpt.source_ordinal).sort((left, right) => left - right);
  return {
    strategy: "whole_document_condensation",
    source_chunk_count: document.chunks.length,
    selected_chunk_count: selected.length,
    first_source_ordinal: ordinals[0] ?? null,
    last_source_ordinal: ordinals.at(-1) ?? null,
    covered_source_locations: selected.reduce((total, excerpt) => total + excerpt.source_locations.length, 0),
  };
}

function chooseWholeDocument(document, query, { limit = MAX_WHOLE_DOCUMENT_EXCERPTS, maxChars = MAX_WHOLE_DOCUMENT_CHARS } = {}) {
  const boundedLimit = Math.max(1, Math.min(MAX_WHOLE_DOCUMENT_EXCERPTS, Math.trunc(limit)));
  const terms = termsFor(query);
  const ranked = document.chunks.map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }));
  const selected = new Map();

  // Retain the most relevant material first, then add evenly spaced chunks so
  // a long script's opening, middle, and ending cannot disappear behind a
  // keyword-only slice.
  const relevant = ranked.filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal);
  const relevanceBudget = Math.min(Math.ceil(boundedLimit * 0.65), relevant.length);
  for (const item of relevant.slice(0, relevanceBudget)) selected.set(item.chunk.ordinal, item);
  if (document.chunks.length <= boundedLimit) {
    for (const item of ranked) selected.set(item.chunk.ordinal, item);
  } else {
    for (let index = 0; index < boundedLimit && selected.size < boundedLimit; index += 1) {
      const ordinal = Math.round(index * (document.chunks.length - 1) / Math.max(1, boundedLimit - 1));
      const item = ranked[ordinal];
      if (item) selected.set(item.chunk.ordinal, item);
    }
    for (const item of ranked) {
      if (selected.size >= boundedLimit) break;
      selected.set(item.chunk.ordinal, item);
    }
  }

  const excerpts = [];
  let used = 0;
  for (const item of [...selected.values()].sort((left, right) => left.chunk.ordinal - right.chunk.ordinal)) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    const text = item.chunk.excerpt.slice(0, Math.min(MAX_CHUNK_CHARS, remaining));
    if (!text) continue;
    excerpts.push(toExcerpt(document, item, text));
    used += text.length;
  }
  return { excerpts, coverage: sourceCoverage(document, excerpts), terms_used: terms };
}

export class LocalDeterministicGroundingSource extends GroundingSource {
  constructor({ store } = {}) {
    super();
    if (!store) throw new Error("LocalDeterministicGroundingSource requires a store");
    this.store = store;
    this.manifest = Object.freeze({
      backend: "local",
      source_id: "local-deterministic-grounding",
      version: "local-grounding@2",
      read_only: true,
      external: false,
      operations: ["condense_whole_document", "select_excerpts", "read_citation"],
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
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }))
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
      excerpts.push(toExcerpt(document, item, excerpt));
      used += excerpt.length;
    }
    return { status: excerpts.length ? "selected" : "gap", excerpts, source: this.manifest, coverage: sourceCoverage(document, excerpts) };
  }

  async condense(documentId, request, options = {}) {
    const document = this.store.getDocument(documentId);
    if (!document) return { status: "missing", excerpts: [], source: this.manifest };
    const condensation = chooseWholeDocument(document, request, options);
    return {
      status: condensation.excerpts.length ? "selected" : "gap",
      excerpts: condensation.excerpts,
      source: this.manifest,
      coverage: condensation.coverage,
      terms_used: condensation.terms_used,
      source_chunk_count: document.chunks.length,
    };
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

export function groundedPromptInput(question, excerpts, { wholeDocument = false, coverage = undefined } = {}) {
  let used = 0;
  const selected = [];
  for (const excerpt of excerpts.slice(0, MAX_SELECTED_EXCERPTS)) {
    const text = String(excerpt.text || "").slice(0, Math.min(MAX_CHUNK_CHARS, MAX_SELECTED_CHARS - used));
    if (!text) continue;
    selected.push({
      citation_id: excerpt.citation_id,
      text,
      source_locations: excerpt.source_locations,
      source_ordinal: excerpt.source_ordinal,
    });
    used += text.length;
    if (used >= MAX_SELECTED_CHARS) break;
  }
  return {
    schema_version: wholeDocument ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA,
    ...(wholeDocument ? { request_intent: normalizeText(question || DEFAULT_SCRIPT_BRIEF_REQUEST, "request_intent", { min: 1, max: 1_000, required: true }) } : { question: normalizeText(question, "question", { min: 1, max: 1_000, required: true }) }),
    excerpts: selected,
    ...(wholeDocument ? { source_coverage: coverage || { strategy: "whole_document_condensation", selected_chunk_count: selected.length }, source_chunk_count: coverage?.source_chunk_count || selected.length } : {}),
  };
}

function assertGroundedText(value, field, max = field === "title" ? 180 : 1_000) {
  const unavailableMediaClaim = /\b(?:video|audio|image|music|vfx)\b.{0,60}\b(?:generate|generation|available|supported|create|produce)\b|\b(?:generate|generation|available|supported|create|produce)\b.{0,60}\b(?:video|audio|image|music|vfx)\b/i.test(value || "");
  if (typeof value !== "string" || value.length < 1 || value.length > max || containsUnsafeText(value) || unavailableMediaClaim) throw new Error(`Grounded proposal ${field} is unsafe or unbounded`);
}

function validateCitationIds(ids, known, { allowEmpty = false } = {}) {
  if (!Array.isArray(ids) || ids.length > MAX_SELECTED_EXCERPTS || (!allowEmpty && ids.length < 1)) throw new Error("Grounded proposal citations are invalid");
  for (const citationId of ids) if (!known.has(citationId)) throw new Error("Grounded proposal cited an unknown citation");
}

export function validateGroundedBriefProposal(value, knownCitationIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grounded proposal must be an object");
  const allowed = new Set(["schema_version", "title", "summary", "key_points", "cited_citation_ids"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Grounded proposal contains unknown field: ${key}`);
  if (value.schema_version !== GROUNDED_BRIEF_SCHEMA) throw new Error(`Grounded proposal schema must be ${GROUNDED_BRIEF_SCHEMA}`);
  assertGroundedText(value.title, "title");
  assertGroundedText(value.summary, "summary");
  if (!Array.isArray(value.key_points) || value.key_points.length > MAX_SELECTED_EXCERPTS) throw new Error("Grounded proposal key_points are invalid");
  const ids = new Set(knownCitationIds);
  validateCitationIds(value.cited_citation_ids, ids, { allowEmpty: ids.size === 0 });
  for (const point of value.key_points) {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Grounded proposal key point is invalid");
    if (Object.keys(point).some((key) => key !== "text" && key !== "citation_ids")) throw new Error("Grounded proposal key point contains an unknown field");
    assertGroundedText(point.text, "key point");
    validateCitationIds(point.citation_ids, ids);
    for (const citationId of point.citation_ids) if (!value.cited_citation_ids.includes(citationId)) throw new Error("Grounded proposal key point citation is missing from cited_citation_ids");
  }
  return value;
}

function validateClaim(claim, field, known, { max = 1_000, allowEmpty = false } = {}) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error(`Grounded proposal ${field} is invalid`);
  const allowed = new Set(["text", "citation_ids"]);
  if (Object.keys(claim).some((key) => !allowed.has(key))) throw new Error(`Grounded proposal ${field} contains an unknown field`);
  assertGroundedText(claim.text, `${field}.text`, max);
  validateCitationIds(claim.citation_ids, known, { allowEmpty });
}

function requireCited(ids, cited) {
  for (const citationId of ids) if (!cited.has(citationId)) throw new Error("Producer intelligence citation is missing from cited_citation_ids");
}

function validateProducerIntelligence(value, known, cited) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Producer intelligence is invalid");
  const allowed = new Set(["schema_version", "scene_breakdown", "cast_and_role_demands", "production_signals", "production_risks", "gaps_and_questions"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Producer intelligence contains an unknown field");
  if (value.schema_version !== PRODUCER_INTELLIGENCE_SCHEMA) throw new Error(`Producer intelligence schema must be ${PRODUCER_INTELLIGENCE_SCHEMA}`);
  const citations = new Set(known);
  if (!Array.isArray(value.scene_breakdown) || value.scene_breakdown.length > MAX_PRODUCER_SCENES) throw new Error("Producer scene breakdown is invalid");
  for (const scene of value.scene_breakdown) {
    if (!scene || typeof scene !== "object" || Object.keys(scene).some((key) => !["scene_heading", "location_wording", "int_ext", "time_of_day", "citation_ids"].includes(key))) throw new Error("Producer scene breakdown item is invalid");
    assertGroundedText(scene.scene_heading, "producer scene heading", 180);
    assertGroundedText(scene.location_wording, "producer location wording", 180);
    if (!["INT", "EXT", "INT/EXT", MISSING_SOURCE].includes(scene.int_ext)) throw new Error("Producer scene INT/EXT value is invalid");
    if (!["DAY", "NIGHT", MISSING_SOURCE].includes(scene.time_of_day)) throw new Error("Producer scene time of day is invalid");
    validateCitationIds(scene.citation_ids, citations);
    requireCited(scene.citation_ids, cited);
  }
  if (!Array.isArray(value.cast_and_role_demands) || value.cast_and_role_demands.length > MAX_PRODUCER_CAST_DEMANDS) throw new Error("Producer cast demands are invalid");
  for (const demand of value.cast_and_role_demands) {
    if (!demand || typeof demand !== "object" || Object.keys(demand).some((key) => !["role", "demand", "citation_ids"].includes(key))) throw new Error("Producer cast demand is invalid");
    assertGroundedText(demand.role, "producer role", 120);
    assertGroundedText(demand.demand, "producer cast demand", 420);
    validateCitationIds(demand.citation_ids, citations);
    requireCited(demand.citation_ids, cited);
  }
  if (!Array.isArray(value.production_signals) || value.production_signals.length > MAX_PRODUCER_SIGNALS) throw new Error("Producer signals are invalid");
  for (const signal of value.production_signals) {
    if (!signal || typeof signal !== "object" || Object.keys(signal).some((key) => !["category", "value", "citation_ids"].includes(key))) throw new Error("Producer production signal is invalid");
    if (!PRODUCER_SIGNAL_CATEGORIES.includes(signal.category)) throw new Error("Producer signal category is invalid");
    assertGroundedText(signal.value, "producer signal", 420);
    validateCitationIds(signal.citation_ids, citations);
    requireCited(signal.citation_ids, cited);
  }
  if (!Array.isArray(value.production_risks) || value.production_risks.length > MAX_PRODUCER_RISKS) throw new Error("Producer risks are invalid");
  for (const risk of value.production_risks) {
    if (!risk || typeof risk !== "object" || Object.keys(risk).some((key) => !["risk", "citation_ids"].includes(key))) throw new Error("Producer risk is invalid");
    assertGroundedText(risk.risk, "producer risk", 420);
    validateCitationIds(risk.citation_ids, citations);
    requireCited(risk.citation_ids, cited);
  }
  if (!Array.isArray(value.gaps_and_questions) || value.gaps_and_questions.length > MAX_PRODUCER_GAPS) throw new Error("Producer gaps are invalid");
  for (const gap of value.gaps_and_questions) {
    if (!gap || typeof gap !== "object" || Object.keys(gap).some((key) => !["category", "question", "citation_ids"].includes(key))) throw new Error("Producer gap is invalid");
    assertGroundedText(gap.category, "producer gap category", 80);
    assertGroundedText(gap.question, "producer gap question", 420);
    validateCitationIds(gap.citation_ids, citations, { allowEmpty: true });
    requireCited(gap.citation_ids, cited);
  }
  return value;
}

export function validateScriptBriefProposal(value, knownCitationIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Script Brief proposal must be an object");
  const allowed = new Set(["schema_version", "title", "logline", "synopsis", "main_characters", "setting_tone_themes", "production_details", "producer_intelligence", "open_questions", "cited_citation_ids"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Script Brief proposal contains unknown field: ${key}`);
  if (value.schema_version !== SCRIPT_BRIEF_SCHEMA) throw new Error(`Script Brief proposal schema must be ${SCRIPT_BRIEF_SCHEMA}`);
  assertGroundedText(value.title, "title");
  const known = new Set(knownCitationIds);
  validateClaim(value.logline, "logline", known, { max: 420 });
  validateClaim(value.synopsis, "synopsis", known, { max: 1_500 });
  if (!Array.isArray(value.main_characters) || value.main_characters.length > 8) throw new Error("Script Brief characters are invalid");
  for (const character of value.main_characters) {
    if (!character || typeof character !== "object" || Array.isArray(character) || Object.keys(character).some((key) => !["name", "description", "citation_ids"].includes(key))) throw new Error("Script Brief character is invalid");
    assertGroundedText(character.name, "character.name", 120);
    assertGroundedText(character.description, "character.description", 600);
    validateCitationIds(character.citation_ids, known);
  }
  if (!value.setting_tone_themes || typeof value.setting_tone_themes !== "object" || Array.isArray(value.setting_tone_themes)) throw new Error("Script Brief setting_tone_themes is invalid");
  const settingKeys = Object.keys(value.setting_tone_themes);
  if (settingKeys.some((key) => !["setting", "tone", "themes", "citation_ids"].includes(key))) throw new Error("Script Brief setting_tone_themes contains an unknown field");
  for (const field of ["setting", "tone"]) assertGroundedText(value.setting_tone_themes[field], `setting_tone_themes.${field}`, 420);
  if (!Array.isArray(value.setting_tone_themes.themes) || value.setting_tone_themes.themes.length > 8) throw new Error("Script Brief themes are invalid");
  value.setting_tone_themes.themes.forEach((theme) => assertGroundedText(theme, "theme", 120));
  validateCitationIds(value.setting_tone_themes.citation_ids, known, { allowEmpty: true });
  if (!Array.isArray(value.production_details) || value.production_details.length > 8) throw new Error("Script Brief production details are invalid");
  for (const detail of value.production_details) {
    if (!detail || typeof detail !== "object" || Object.keys(detail).some((key) => !["label", "value", "citation_ids"].includes(key))) throw new Error("Script Brief production detail is invalid");
    assertGroundedText(detail.label, "production_detail.label", 120);
    assertGroundedText(detail.value, "production_detail.value", 420);
    validateCitationIds(detail.citation_ids, known);
  }
  if (!Array.isArray(value.open_questions) || value.open_questions.length > 8) throw new Error("Script Brief open questions are invalid");
  for (const question of value.open_questions) {
    if (!question || typeof question !== "object" || Object.keys(question).some((key) => !["question", "citation_ids"].includes(key))) throw new Error("Script Brief open question is invalid");
    assertGroundedText(question.question, "open_question.question", 420);
    validateCitationIds(question.citation_ids, known, { allowEmpty: true });
  }
  validateCitationIds(value.cited_citation_ids, known, { allowEmpty: known.size === 0 });
  const cited = new Set(value.cited_citation_ids);
  if (value.producer_intelligence) validateProducerIntelligence(value.producer_intelligence, known, cited);
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

function words(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean);
}

function wordLimit(value, maxWords) {
  const result = words(value).slice(0, maxWords).join(" ");
  return result || "The source does not establish this clearly.";
}

function sentences(excerpts) {
  return excerpts.flatMap((excerpt) => String(excerpt.text).split(/(?<=[.!?])\s+|\n+/).map((text) => ({ text: text.trim(), citation_id: excerpt.citation_id })).filter((item) => item.text));
}

function namesFromText(text) {
  const names = [];
  const add = (name) => {
    const normalized = name.replace(/[.:,;!?]+$/, "").trim();
    if (!normalized || NAME_STOP_WORDS.has(normalized.toUpperCase()) || normalized.length < 3 || names.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return;
    names.push(normalized);
  };
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9']{2,}\b/g)) add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) add(match[0]);
  return names.slice(0, 6);
}

function sourceSentenceFor(name, sourceSentences) {
  return sourceSentences.find((sentence) => sentence.text.toLocaleLowerCase().includes(name.toLocaleLowerCase())) || sourceSentences[0];
}

function parseSceneHeading(value) {
  const heading = String(value || "").trim();
  const match = heading.match(/^(INT\.?\s*\/\s*EXT\.?|I\/E\.?|INT\.?|EXT\.?)\s+(.+)$/i);
  if (!match) {
    const explicit = heading.match(/^(?:LOCATION|PLACE|VENUE)\s*:\s*(.+)$/i);
    if (!explicit) return undefined;
    return { scene_heading: heading, location_wording: explicit[1].trim() || MISSING_SOURCE, int_ext: MISSING_SOURCE, time_of_day: MISSING_SOURCE };
  }
  const intExt = match[1].toUpperCase().replace(/\.?\s*\/\s*EXT\.?$/, "/EXT").replace(/\.$/, "");
  const time = match[2].match(/\s+-\s+[^\n.!?]*?\b(DAY|NIGHT)\b(?:\s+-\s+[^\n.!?]*)?$/i);
  const location = (time ? match[2].slice(0, time.index) : match[2]).trim();
  return {
    scene_heading: heading,
    location_wording: location || MISSING_SOURCE,
    int_ext: intExt === "I/E" ? "INT/EXT" : intExt,
    time_of_day: time ? time[1].toUpperCase() : MISSING_SOURCE,
  };
}

function firstSceneHeading(text) {
  return String(text || "").split(/\n+/).map((line) => parseSceneHeading(line)?.scene_heading).find(Boolean);
}

function sourceLines(excerpts) {
  return excerpts.flatMap((excerpt) => String(excerpt.text || "").split(/\n+/).map((line) => ({ text: line.trim(), citation_id: excerpt.citation_id })).filter((line) => line.text));
}

function producerScenes(excerpts) {
  const scenes = new Map();
  for (const excerpt of excerpts) {
    const candidates = [
      ...String(excerpt.text || "").split(/\n+/).map((line) => line.trim()),
      ...(excerpt.source_locations || []).map((location) => location.section).filter(Boolean),
    ];
    for (const candidate of candidates) {
      const parsed = parseSceneHeading(candidate);
      if (!parsed) continue;
      const existing = scenes.get(parsed.scene_heading) || { ...parsed, citation_ids: [] };
      if (!existing.citation_ids.includes(excerpt.citation_id)) existing.citation_ids.push(excerpt.citation_id);
      scenes.set(parsed.scene_heading, existing);
    }
  }
  return [...scenes.values()].slice(0, MAX_PRODUCER_SCENES);
}

const PRODUCER_SIGNAL_PATTERNS = Object.freeze({
  props: /\b(?:prop|props|holds?|carries?|grabs?|picks up|opens? the|takes? the)\b/i,
  vehicles: /\b(?:car|taxi|motorcycle|motorbike|scooter|bus|van|truck|vehicle|boat|train|ferry|bicycle|bike)\b/i,
  costume: /\b(?:wears?|wearing|dressed|costume|uniform|sari|tuxedo|scrubs|school clothes)\b/i,
  set: /(?:\bset\s*:|\b(?:set dressing|furniture|decor(?:ation)?|wallpaper|curtains?|bookcase|interior is|room is filled)\b)/i,
  stunts: /\b(?:stunt|fight(?:s|ing)?|chase(?:s|d)?|falls?|jumps?|crash(?:es|ed)?|punch(?:es|ed)?|kicks?|tackles?)\b/i,
  vfx: /\b(?:VFX|CGI|visual effect|green[- ]screen|wire removal|digital double)\b/i,
  sound: /\b(?:sound|music|song|radio|phone rings?|alarm|sirens?|voice[- ]over|O\.S\.|SFX)\b/i,
  weather: /\b(?:weather|rain(?:s|ing)?|storm|thunder|lightning|fog|snow|wind(?:y)?|sunlight|humid(?:ity)?)\b/i,
  crowds: /\b(?:crowd|crowds|extras|dozens|hundreds|market|festival|packed|crowded)\b/i,
  minors: /(?:\b(?:child(?:ren)?|kid|kids|boy|girl|teen(?:ager)?|minor|\d{1,2}[- ]year[- ]old)\b|\(\s*\d{1,2}\s*\))/i,
  animals: /\b(?:animal|dog|cat|horse|bird|snake|monkey|pet)\b/i,
  company_moves: /\b(?:company move|move to the next location|company travels|crew moves|new location)\b/i,
  continuity: /\b(?:continuity|still wearing|same as before|remains on|later that night|next morning|days later|weeks later)\b/i,
  scheduling: /\b(?:scheduling|night shoot|day shoot|golden hour|call time|dawn|sunset|same day|flashback|one week later)\b/i,
});

function producerSignals(excerpts) {
  const lines = sourceLines(excerpts);
  const signals = [];
  for (const category of PRODUCER_SIGNAL_CATEGORIES) {
    const matches = lines.filter((line) => PRODUCER_SIGNAL_PATTERNS[category].test(line.text)).slice(0, 2);
    if (!matches.length) continue;
    const citationIds = [...new Set(matches.map((line) => line.citation_id).filter(Boolean))].slice(0, MAX_SELECTED_EXCERPTS);
    signals.push({ category, value: matches.map((line) => line.text.slice(0, 420)).join(" / ").slice(0, 420), citation_ids: citationIds });
    if (signals.length >= MAX_PRODUCER_SIGNALS) break;
  }
  return signals;
}

function producerCastDemands(excerpts) {
  const demands = [];
  const seen = new Set();
  for (const line of sourceLines(excerpts)) {
    const ageOrDemand = line.text.match(/(?:\(\s*\d{1,2}\s*\)|\b\d{1,2}\s*(?:years?\s*old|yo|s)\b|\b(?:child(?:ren)?|kid|teen(?:ager)?|elderly|pregnant|twins?|accent|dialect|wheelchair|deaf|blind)\b)/i);
    const namedRole = line.text.match(/\b([A-Z][A-Z0-9']{2,})\b/);
    const castLabel = line.text.match(/^\s*CAST\s*:\s*([^:-]{1,80})(?:\s*[-:]\s*(.+))?$/i);
    const role = castLabel?.[1]?.trim() || namedRole?.[1] || ageOrDemand?.[0];
    if (!role || (!ageOrDemand && !castLabel)) continue;
    const key = `${role.toLocaleLowerCase()}|${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    demands.push({ role, demand: line.text.slice(0, 420), citation_ids: line.citation_id ? [line.citation_id] : [] });
    if (demands.length >= MAX_PRODUCER_CAST_DEMANDS) break;
  }
  return demands;
}

const PRODUCER_SIGNAL_LABELS = Object.freeze({
  props: "props", vehicles: "vehicles", costume: "costume", set: "set", stunts: "stunt or physical action", vfx: "VFX", sound: "sound", weather: "weather", crowds: "crowds or extras", minors: "minors", animals: "animals", company_moves: "company moves", continuity: "continuity", scheduling: "scheduling",
});

function producerGaps(scenes, castDemands, signals) {
  const gaps = [];
  if (!scenes.length) gaps.push({ category: "locations", question: "What exact filming location or venue should production prepare for? A named location or scene heading is not stated in the source; confirm the intended place with the producer.", citation_ids: [] });
  if (scenes.some((scene) => scene.time_of_day === MISSING_SOURCE)) {
    gaps.push({ category: "scene timing", question: "Which scene(s) should be treated as day or night? The screenplay does not state the time of day for every scene; confirm the intended timing with the producer.", citation_ids: [...new Set(scenes.filter((scene) => scene.time_of_day === MISSING_SOURCE).flatMap((scene) => scene.citation_ids))].slice(0, MAX_SELECTED_EXCERPTS) });
  }
  if (!castDemands.length) gaps.push({ category: "cast and role demands", question: "Which cast or role demands should production prepare for? They are not stated in the source; confirm the principal roles and any age, ability, or performance requirements with the producer.", citation_ids: [] });
  const present = new Set(signals.map((signal) => signal.category));
  for (const category of PRODUCER_SIGNAL_CATEGORIES) {
    if (present.has(category)) continue;
    gaps.push({ category: PRODUCER_SIGNAL_LABELS[category], question: `What ${PRODUCER_SIGNAL_LABELS[category]} requirements should production prepare for? They are not stated in the source; confirm with the producer.`, citation_ids: [] });
    if (gaps.length >= MAX_PRODUCER_GAPS) break;
  }
  return gaps.slice(0, MAX_PRODUCER_GAPS);
}

function producerRisks(signals, excerpts) {
  const riskCategories = new Set(["stunts", "vfx", "weather", "crowds", "minors", "animals", "company_moves", "continuity", "scheduling"]);
  const derived = signals.filter((signal) => riskCategories.has(signal.category)).map((signal) => ({
    risk: `The source describes ${PRODUCER_SIGNAL_LABELS[signal.category]}; confirm the practical requirements before production planning.`,
    citation_ids: signal.citation_ids,
  }));
  const explicit = sourceLines(excerpts).filter((line) => /^\s*(?:PRODUCTION\s+)?RISK\s*:/i.test(line.text)).map((line) => ({ risk: line.text.slice(0, 420), citation_ids: line.citation_id ? [line.citation_id] : [] }));
  return [...explicit, ...derived].slice(0, MAX_PRODUCER_RISKS);
}

function deterministicProducerIntelligence(excerpts) {
  const scenes = producerScenes(excerpts);
  const castDemands = producerCastDemands(excerpts);
  const signals = producerSignals(excerpts);
  return {
    schema_version: PRODUCER_INTELLIGENCE_SCHEMA,
    scene_breakdown: scenes,
    cast_and_role_demands: castDemands,
    production_signals: signals,
    production_risks: producerRisks(signals, excerpts),
    gaps_and_questions: producerGaps(scenes, castDemands, signals),
  };
}

function deterministicScriptBriefProposal(input) {
  const excerpts = input.excerpts || [];
  const citationIds = [...new Set(excerpts.map((excerpt) => excerpt.citation_id).filter(Boolean))].slice(0, MAX_SELECTED_EXCERPTS);
  const sourceSentences = sentences(excerpts);
  const sourceText = excerpts.map((excerpt) => excerpt.text).join("\n");
  const lead = sourceSentences[0] || { text: "The uploaded source does not contain enough readable text for a story brief.", citation_id: citationIds[0] };
  const synopsisText = wordLimit(sourceSentences.slice(0, 12).map((sentence) => sentence.text).join(" "), 140);
  const loglineText = wordLimit(sourceSentences.slice(0, 3).map((sentence) => sentence.text).join(" "), 35);
  const mainCharacters = namesFromText(sourceText).map((name) => {
    const sentence = sourceSentenceFor(name, sourceSentences);
    return { name, description: wordLimit(sentence.text, 45), citation_ids: [sentence.citation_id] };
  });
  const heading = firstSceneHeading(sourceText);
  const settingSentence = sourceSentences.find((sentence) => firstSceneHeading(sentence.text)) || lead;
  const tone = TONE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(sourceText));
  const themes = THEME_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(sourceText));
  const setting = heading || wordLimit(settingSentence.text, 30);
  const settingCitation = settingSentence.citation_id ? [settingSentence.citation_id] : [];
  const details = [];
  const headings = [...new Set(excerpts.flatMap((excerpt) => String(excerpt.text).split("\n").map((line) => firstSceneHeading(line)).filter(Boolean)))].slice(0, 4);
  if (headings.length) details.push({ label: "Scene locations", value: headings.join("; "), citation_ids: [...new Set(excerpts.filter((excerpt) => headings.some((item) => excerpt.text.includes(item))).map((excerpt) => excerpt.citation_id))].slice(0, 4) });
  const sections = [...new Set(excerpts.flatMap((excerpt) => excerpt.source_locations.map((location) => location.section).filter(Boolean)))].slice(0, 4);
  if (sections.length) details.push({ label: "Source sections", value: sections.join("; "), citation_ids: citationIds.slice(0, Math.max(1, sections.length)) });
  if (mainCharacters.length) details.push({ label: "Named roles found", value: `${mainCharacters.length} named role${mainCharacters.length === 1 ? "" : "s"} appear in the source excerpts.`, citation_ids: mainCharacters.flatMap((character) => character.citation_ids).slice(0, 6) });
  const openQuestions = [];
  if (!mainCharacters.length) openQuestions.push({ question: "Which characters should the production team treat as the principal roles? The source excerpts do not identify them clearly.", citation_ids: [] });
  if (!heading && !settingSentence.text) openQuestions.push({ question: "What is the primary setting? It is not established in the source excerpts.", citation_ids: [] });
  if (!tone.length || !themes.length) openQuestions.push({ question: "What tone or themes should the team prioritize? They are not stated clearly in the source excerpts.", citation_ids: [] });
  const producerIntelligence = deterministicProducerIntelligence(excerpts);
  return {
    schema_version: SCRIPT_BRIEF_SCHEMA,
    title: "Script Brief",
    logline: { text: loglineText, citation_ids: lead.citation_id ? [lead.citation_id] : [] },
    synopsis: { text: synopsisText, citation_ids: citationIds.slice(0, 12) },
    main_characters: mainCharacters,
    setting_tone_themes: {
      setting,
      tone: tone.length ? tone.join(", ") : "Not stated clearly in the source excerpts.",
      themes,
      citation_ids: settingCitation.length ? settingCitation : citationIds.slice(0, 1),
    },
    production_details: details.slice(0, 8),
    producer_intelligence: producerIntelligence,
    open_questions: openQuestions.slice(0, 8),
    cited_citation_ids: citationIds,
  };
}

export { deterministicProducerIntelligence, deterministicScriptBriefProposal };

export class GroundedBriefModel extends ModelGateway {
  provenance() {
    return { backend: "fake", model_id: null, location: null, api_version: null, prompt_id: SCRIPT_BRIEF_PROMPT_ID, prompt_hash: null, schema_version: SCRIPT_BRIEF_SCHEMA, schema_hash: null, generation_config_hash: null };
  }

  async groundedBrief(input) {
    return input?.schema_version === SCRIPT_BRIEF_SCHEMA ? deterministicScriptBriefProposal(input) : deterministicGroundedBriefProposal(input);
  }
}
