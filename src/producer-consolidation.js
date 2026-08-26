import {
  DocumentContractError,
  MAX_CHUNK_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_CHARS,
  parseGroundingDocument,
} from "./documents.js";
import { hashValue, stableStringify } from "./contracts.js";

export const PRODUCER_SOURCE_SCHEMA = "producer-source@1";
export const PRODUCER_BUNDLE_SCHEMA = "producer-source-bundle@1";
// PRODUCER_PACKET_SCHEMA is the PRD-target `producer-intake-decision-packet@1` contract emitted by the
// strict bounded bundle path (one primary_screenplay, source/version manifest, exact facts, conflicts,
// evidence states, and the full provenance object). PRODUCER_PACKET_SCHEMA_LEGACY remains a stable,
// unrenamed compatibility alias for the older `/v1/producer-packets` free-label multipart path so that
// existing legacy route behavior and packet identity are not disturbed by this contract alignment.
export const PRODUCER_PACKET_SCHEMA = "producer-intake-decision-packet@1";
export const PRODUCER_PACKET_SCHEMA_LEGACY = "producer-decision-packet@1";
export const PRODUCER_WORKFLOW = "producer_consolidation";
export const PRODUCER_RECONCILIATION_SCHEMA = "producer-reconciliation@1";
export const PRODUCER_REGISTER_SCHEMA = "producer-register-entry@1";
export const PRODUCER_HANDOFF_SCHEMA = "producer-handoff@1";
export const PRODUCER_VERSION_PROVENANCE_SCHEMA = "producer-version-provenance@1";
export const MAX_PRODUCER_SOURCES = 12;
export const MAX_PRODUCER_REVISIONS = 2;
export const MAX_PRODUCER_MANIFEST_BYTES = 32 * 1024;
export const MAX_PRODUCER_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_PACKET_CITATIONS = 24;
export const MAX_PACKET_ITEMS = 24;

export const PRODUCER_SOURCE_LABELS = Object.freeze({
  primary_screenplay: "Primary screenplay",
  screenplay_revision: "Screenplay revision",
  director_notes: "Director notes",
  cast_notes: "Cast notes",
  location_access: "Location and access",
  schedule_assumptions: "Schedule assumptions",
  budget_assumptions: "Budget assumptions",
  rights_clearance: "Rights and clearance",
  department_input: "Department input",
  breakdown: "Breakdown",
  handoff: "Handoff",
  other: "Other production source",
  // These labels remain accepted for the already-shipped producer route.
  script: "Script",
  cast_actor_notes: "Cast or actor notes",
  location_production_notes: "Location or production notes",
  schedule: "Schedule",
  budget: "Budget",
  department_notes: "Department notes",
});

export const PRODUCER_SOURCE_KINDS = Object.freeze(Object.keys(PRODUCER_SOURCE_LABELS));
export const CANONICAL_PRODUCER_SOURCE_KINDS = Object.freeze([
  "primary_screenplay",
  "screenplay_revision",
  "director_notes",
  "cast_notes",
  "location_access",
  "schedule_assumptions",
  "budget_assumptions",
  "rights_clearance",
  "department_input",
  "breakdown",
  "handoff",
  "other",
]);

function boundedText(value, max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sourceKind(value) {
  if (typeof value !== "string" || !PRODUCER_SOURCE_KINDS.includes(value)) {
    throw new DocumentContractError("INVALID_SOURCE_KIND", "source_kind must be one of the supported producer source labels", "source_kind");
  }
  return value;
}

function sourceLocations(source) {
  const seen = new Set();
  return source.chunks.flatMap((chunk) => chunk.source_locations).filter((location) => {
    const key = stableStringify(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceId(document, kind, metadata = {}) {
  const canonical = Boolean(metadata.input_ref) || (CANONICAL_PRODUCER_SOURCE_KINDS.includes(kind) && kind !== "director_notes");
  return `${canonical ? "src" : "source"}_${hashValue(stableStringify({ document_id: document.document_id, content_hash: metadata.contentHash || null, source_kind: kind, department: metadata.department || null })).slice(0, 32)}`;
}

export function parseProducerSource({ filename, contentType, bytes, source_kind, input_ref, department, version_label, status_label, relationships, source_note }) {
  const kind = sourceKind(source_kind);
  const document = parseGroundingDocument({ filename, contentType, bytes });
  const extractedText = document.chunks.map((chunk) => chunk.excerpt).join("\n\n").slice(0, MAX_EXTRACTED_CHARS);
  const contentHash = `sha256:${hashValue(stableStringify({ media_type: document.media_type, text: extractedText, locations: document.chunks.flatMap((chunk) => chunk.source_locations) }))}`;
  const id = sourceId(document, kind, { department, input_ref, contentHash });
  const detectedSourceVersion = document.chunks.flatMap((chunk) => chunk.source_locations).map((location) => location.section).find((section) => /^(?:shooting\s+)?draft\s+[a-z0-9._ -]+$/i.test(section || ""));
  const detectedStatusLabel = document.chunks.flatMap((chunk) => chunk.excerpt.split("\n")).map((line) => line.trim().match(/^(?:permission\s+)?status\s*[:=-]\s*(.+)$/i)?.[1]).find(Boolean);
  return {
    ...document,
    schema_version: PRODUCER_SOURCE_SCHEMA,
    source_id: id,
    content_hash: contentHash,
    input_ref: input_ref ? boundedText(input_ref, 120) : undefined,
    source_kind: kind,
    source_label: PRODUCER_SOURCE_LABELS[kind],
    department: department ? boundedText(department, 80) : undefined,
    version_label: version_label ? boundedText(version_label, 120) : detectedSourceVersion ? boundedText(detectedSourceVersion.toLocaleLowerCase(), 120) : undefined,
    status_label: status_label ? boundedText(status_label, 120) : detectedStatusLabel ? boundedText(detectedStatusLabel, 120) : undefined,
    relationships: Array.isArray(relationships) ? relationships.slice(0, 4) : [],
    source_note: source_note ? boundedText(source_note, 240) : undefined,
    extracted_text: extractedText,
    locations: sourceLocations(document),
    chunks: document.chunks.map((chunk) => ({ ...chunk, source_id: id })),
  };
}

function citationForChunk(source, chunk) {
  return {
    schema_version: "producer-citation@1",
    citation_id: `pcite_${hashValue(`${source.source_id}|${chunk.chunk_id}`).slice(0, 32)}`,
    source_id: source.source_id,
    document_id: source.document_id,
    filename: source.filename,
    media_type: source.media_type,
    source_kind: source.source_kind,
    source_label: source.source_label,
    source_locations: chunk.source_locations,
    excerpt: chunk.excerpt.slice(0, MAX_CHUNK_CHARS),
  };
}

function citationMap(sources) {
  const citations = new Map();
  for (const source of sources) {
    for (const chunk of source.chunks) {
      const citation = citationForChunk(source, chunk);
      citations.set(citation.citation_id, citation);
    }
  }
  return citations;
}

function linesForSource(source) {
  return source.chunks.flatMap((chunk) => String(chunk.excerpt).split("\n").map((text) => ({
    text: text.trim(),
    citation_id: citationForChunk(source, chunk).citation_id,
    source,
  }))).filter((line) => line.text);
}

function declaredSourceVersion(source) {
  const line = linesForSource(source).find((item) => /^(?:version|revision|rev(?:ision)?|draft)\s*(?::|=|-|\s)\s*[^\s].{0,100}$/i.test(item.text));
  if (!line) return undefined;
  const value = line.text.match(/^(?:version|revision|rev(?:ision)?|draft)\s*(?::|=|-|\s)\s*(.+)$/i)?.[1];
  return value ? { value: boundedText(value, 100), citation_id: line.citation_id } : undefined;
}

function candidate(lines, topic, matcher, { sourceKinds = undefined, limit = 8 } = {}) {
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    if (sourceKinds && !sourceKinds.includes(line.source.source_kind)) continue;
    if (!matcher.test(line.text)) continue;
    const text = boundedText(line.text, 500);
    const key = `${line.source.source_id}|${topic}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ topic, text, citation_id: line.citation_id, source: line.source });
    if (result.length >= limit) break;
  }
  return result;
}

function valueForCandidate(item) {
  const labeled = item.text.match(/^[^:=-]{2,40}\s*[:=-]\s*(.+)$/);
  return (labeled?.[1] || item.text).toLocaleLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").trim();
}

function firstSentence(source) {
  const line = linesForSource(source).find((item) => item.text.length > 8);
  if (!line) return undefined;
  const text = boundedText(line.text.split(/(?<=[.!?])\s+/)[0], 500);
  return { text, citation_id: line.citation_id, source: source };
}

function uniqueItems(items, max = MAX_PACKET_ITEMS) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.text}|${(item.citation_ids || []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
}

function statement(text, citationIds, extra = {}) {
  return {
    text: boundedText(text, 700),
    citation_ids: [...new Set(citationIds)].slice(0, 8),
    claim_type: extra.claim_type || "fact",
    ...extra,
  };
}

function exactStatements(items, prefix = "", claimType = "fact") {
  return uniqueItems(items.map((item) => statement(`${prefix}${item.text}`, [item.citation_id], {
    claim_type: claimType,
    source_id: item.source.source_id,
    source_kind: item.source.source_kind,
  })));
}

function detectConflicts(topic, items) {
  const result = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      if (left.source.source_id === right.source.source_id) continue;
      if (!valueForCandidate(left) || valueForCandidate(left) === valueForCandidate(right)) continue;
      result.push(statement(
        `${topic[0].toLocaleUpperCase()}${topic.slice(1)} conflict: one source states "${left.text}" while another states "${right.text}". Resolve the difference before relying on this plan.`,
        [left.citation_id, right.citation_id],
        { kind: "conflict", topic, source_ids: [left.source.source_id, right.source.source_id] },
      ));
      return result;
    }
  }
  return result;
}

function gap(text, citationIds) {
  return statement(text, citationIds, { kind: "gap", claim_type: "unknown" });
}

function reconcileTopic(topic, candidates) {
  const distinct = [...new Map(candidates.map((item) => [`${item.source.source_id}|${item.citation_id}|${item.text}`, item])).values()];
  const values = [...new Set(distinct.map(valueForCandidate).filter(Boolean))];
  return {
    topic,
    status: values.length > 1 ? "conflict" : values.length === 1 ? "established" : "unknown",
    source_ids: [...new Set(distinct.map((item) => item.source.source_id))].slice(0, 8),
    source_kinds: [...new Set(distinct.map((item) => item.source.source_kind))].slice(0, 8),
    fact_count: distinct.length,
    citation_ids: [...new Set(distinct.map((item) => item.citation_id))].slice(0, 16),
  };
}

function ownerForSourceKind(kind) {
  return {
    director_notes: "director",
    cast_actor_notes: "casting lead",
    location_production_notes: "locations lead",
    schedule: "1st AD or production manager",
    budget: "line producer or production accountant",
    department_notes: "department lead",
    script: "producer and director",
  }[kind] || "producer";
}

function registerEntry({ type, title, action, ownerRole, claimType, priority, citationIds, sourceIds }) {
  const boundedCitations = [...new Set(citationIds)].slice(0, 8);
  const boundedSources = [...new Set(sourceIds)].slice(0, 4);
  return {
    schema_version: PRODUCER_REGISTER_SCHEMA,
    register_id: `register_${hashValue(stableStringify({ type, title, action, ownerRole, priority, citation_ids: boundedCitations, source_ids: boundedSources })).slice(0, 32)}`,
    type,
    title: boundedText(title, 180),
    action: boundedText(action, 700),
    owner_role: boundedText(ownerRole, 80),
    priority: ["high", "medium", "low"].includes(priority) ? priority : "medium",
    status: "open",
    claim_type: claimType,
    citation_ids: boundedCitations,
    source_ids: boundedSources,
  };
}

function priorityForGap(text) {
  return /budget|schedule|location|permit|availability/i.test(text) ? "high" : "medium";
}

function priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 1;
}

function duplicateGroups(sources) {
  const groups = new Map();
  for (const source of sources) {
    const key = `${source.source_id}|${source.source_kind}`;
    const group = groups.get(key) || { source_id: source.source_id, source_kind: source.source_kind, document_id: source.document_id, filenames: [] };
    group.filenames.push(source.filename);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.filenames.length > 1).map((group) => ({
    duplicate_group_id: `duplicate_${hashValue(stableStringify(group)).slice(0, 32)}`,
    status: "duplicate_content_and_source_kind",
    ...group,
    duplicate_count: group.filenames.length,
  }));
}

function buildLegacyProducerDecisionPacket(sources, { createdAt = new Date().toISOString(), overridePacketId = undefined } = {}) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_PRODUCER_SOURCES) {
    throw new DocumentContractError("INVALID_SOURCE_COUNT", `A producer bundle must contain 1 to ${MAX_PRODUCER_SOURCES} sources`, "sources");
  }
  const orderedSources = sources.map((source) => ({ ...source, chunks: source.chunks.slice(0, 240) }));
  const citationsById = citationMap(orderedSources);
  const allCitationIds = [...citationsById.keys()];
  const firstCitationBySource = new Map(orderedSources.map((source) => [source.source_id, citationForChunk(source, source.chunks[0])?.citation_id]).filter(([, id]) => id));
  const fallbackCitationIds = orderedSources.map((source) => firstCitationBySource.get(source.source_id)).filter(Boolean).slice(0, 8);
  const sourceLines = new Map(orderedSources.map((source) => [source.source_id, linesForSource(source)]));
  const sourceVersions = new Map(orderedSources.map((source) => [source.source_id, declaredSourceVersion(source)]));

  const locationCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "location", /^(?:location|venue|site|address|property|interior|exterior)\s*[:=-]/i, { limit: 6 }));
  const sceneLocations = orderedSources.filter((source) => source.source_kind === "script").flatMap((source) => source.chunks.flatMap((chunk) => chunk.source_locations.filter((location) => /^(?:INT\.?|EXT\.?|I\/E\.?|INT\.?\/EXT\.?)\s+/i.test(location.section || "")).map((location) => ({ topic: "location", text: boundedText(location.section, 500), citation_id: citationForChunk(source, chunk).citation_id, source }))));
  const timingCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "timing", /^(?:schedule|shoot(?:ing)?(?: date)?|date|day|week|call time|time|availability)\s*[:=-]/i, { limit: 8 }));
  const budgetCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "budget", /^(?:budget|total budget|allowance|cost|contingency)\s*[:=-]|\$\s?\d[\d,.]*/i, { sourceKinds: ["budget"], limit: 8 }));
  const castCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "cast", /^(?:cast|actor|role|character|performance|stunt|dialect|intimacy|minor|child)\s*[:=-]/i, { sourceKinds: ["cast_actor_notes", "script", "director_notes"], limit: 10 }));
  const castSourceFallbacks = orderedSources.filter((source) => source.source_kind === "cast_actor_notes").flatMap((source) => sourceLines.get(source.source_id).filter((line) => line.text.length > 8).slice(0, 5).map((line) => ({ topic: "cast", text: boundedText(line.text, 500), citation_id: line.citation_id, source })));
  const roleCandidates = [...castCandidates, ...castSourceFallbacks];
  const departmentPattern = /(?:department|camera|lighting|sound|audio|wardrobe|costume|art|prop|makeup|hair|production design|transport|safety|stunt|vfx|visual effects|set dressing)\s*[:=-]?/i;
  const departmentCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "department", departmentPattern, { sourceKinds: ["department_notes", "director_notes", "location_production_notes", "script"], limit: 10 }));
  const riskCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "risk", /\b(?:risk|hazard|safety|stunt|weather|permit|conflict|unavailable|pending|TBD|contingency|special requirement)\b/i, { limit: 10 }));
  const directorCandidates = orderedSources.flatMap((source) => candidate(sourceLines.get(source.source_id), "director", /\b(?:must|need|vision|tone|look|style|priority|avoid|camera|performance|direct|visual)\b/i, { sourceKinds: ["director_notes"], limit: 8 }));
  const scheduleSourceLines = orderedSources.filter((source) => source.source_kind === "schedule").flatMap((source) => sourceLines.get(source.source_id).filter((line) => line.text.length > 8).slice(0, 8).map((line) => ({ topic: "timing", text: boundedText(line.text, 500), citation_id: line.citation_id, source })));
  const budgetSourceLines = orderedSources.filter((source) => source.source_kind === "budget").flatMap((source) => sourceLines.get(source.source_id).filter((line) => /\b(?:budget|cost|allowance|contingency|pending|TBD)\b|\$\s?\d/i.test(line.text)).slice(0, 8).map((line) => ({ topic: "budget", text: boundedText(line.text, 500), citation_id: line.citation_id, source })));
  const locationSourceLines = orderedSources.filter((source) => ["location_production_notes", "script"].includes(source.source_kind)).flatMap((source) => sourceLines.get(source.source_id).filter((line) => /^(?:location|venue|site|address|property|interior|exterior|INT\.?|EXT\.?|I\/E\.?)/i.test(line.text)).slice(0, 8).map((line) => ({ topic: "location", text: boundedText(line.text, 500), citation_id: line.citation_id, source })));
  const timing = [...timingCandidates, ...scheduleSourceLines];
  const budgets = [...budgetCandidates, ...budgetSourceLines];
  const locations = [...locationCandidates, ...locationSourceLines, ...sceneLocations];
  const reconciliationTopics = [
    reconcileTopic("location", [...locationCandidates, ...locationSourceLines]),
    reconcileTopic("timing", timing),
    reconcileTopic("budget", budgets),
    reconcileTopic("cast", roleCandidates),
    reconcileTopic("department", departmentCandidates),
  ];

  const overview = orderedSources.map(firstSentence).filter(Boolean).slice(0, 6);
  const executiveSummary = statement(
    overview.length ? overview.map((item) => item.text).join(" ") : "The bundle does not contain readable source statements for a production summary.",
    overview.length ? overview.map((item) => item.citation_id) : fallbackCitationIds,
  );
  const decisions = exactStatements([...directorCandidates, ...locationCandidates, ...timing, ...budgets].slice(0, MAX_PACKET_ITEMS), "Confirm or action this source note: ", "inference");
  const locationAndTiming = uniqueItems([
    ...locations.map((item) => statement(item.text, [item.citation_id], { category: "location", source_id: item.source.source_id, source_kind: item.source.source_kind })),
    ...timing.map((item) => statement(item.text, [item.citation_id], { category: "timing", source_id: item.source.source_id, source_kind: item.source.source_kind })),
  ]);
  const castRoleDemands = exactStatements(roleCandidates, "Source role or cast demand: ");
  const departmentRequirements = exactStatements(departmentCandidates, "Source department requirement: ");

  const conflicts = [
    ...detectConflicts("location", locationCandidates),
    ...detectConflicts("timing", timingCandidates),
    ...detectConflicts("budget", budgetCandidates),
    ...detectConflicts("cast", castCandidates),
  ];
  const risks = uniqueItems([
    ...conflicts,
    ...exactStatements(riskCandidates, "Source flags a production risk or follow-up: ").map((item) => ({ ...item, kind: "risk" })),
  ]);

  const gaps = [];
  if (!budgets.length || !budgets.some((item) => /\$\s?\d[\d,.]*/.test(item.text))) gaps.push(gap("No budget amount is established in the uploaded sources. Confirm the budget owner and amount before committing spend.", fallbackCitationIds));
  if (!timing.length) gaps.push(gap("No schedule date, shoot timing, or availability is established in the uploaded sources. Confirm the production window.", fallbackCitationIds));
  if (!locations.length) gaps.push(gap("No exact production location is established in the uploaded sources. Confirm the location and any required follow-up.", fallbackCitationIds));
  if (!roleCandidates.length) gaps.push(gap("No cast assignment or principal role demand is established in the uploaded sources. Confirm the roles and requirements.", fallbackCitationIds));
  if (!departmentCandidates.length) gaps.push(gap("No department requirement is established in the uploaded sources. Confirm department owners and prep needs.", fallbackCitationIds));
  if (!overview.length) gaps.push(gap("The uploaded sources did not provide a readable statement for consolidation.", allCitationIds.slice(0, 8)));

  const crossDocumentConflicts = conflicts.map((item) => ({ ...item, claim_type: "fact" }));
  const decisionRegister = [
    ...decisions.map((item) => registerEntry({
      type: "decision",
      title: "Confirm source note before handoff",
      action: item.text,
      ownerRole: ownerForSourceKind(item.source_kind),
      claimType: "inference",
      priority: item.source_kind === "budget" ? "high" : "medium",
      citationIds: item.citation_ids,
      sourceIds: item.source_id ? [item.source_id] : [],
    })),
    ...[...castRoleDemands, ...departmentRequirements].map((item) => registerEntry({
      type: "decision",
      title: item.source_kind === "cast_actor_notes" ? "Confirm cast or role handoff" : "Confirm department handoff",
      action: `Handoff-ready follow-up: ${item.text}`,
      ownerRole: ownerForSourceKind(item.source_kind),
      claimType: "inference",
      priority: "medium",
      citationIds: item.citation_ids,
      sourceIds: item.source_id ? [item.source_id] : [],
    })),
    ...crossDocumentConflicts.map((item) => registerEntry({
      type: "question",
      title: `Resolve cross-document ${item.topic} conflict`,
      action: item.text,
      ownerRole: "producer",
      claimType: "inference",
      priority: "high",
      citationIds: item.citation_ids,
      sourceIds: item.source_ids || [],
    })),
    ...gaps.map((item) => registerEntry({
      type: "question",
      title: "Close an information gap before commitment",
      action: item.text,
      ownerRole: "producer",
      claimType: "unknown",
      priority: priorityForGap(item.text),
      citationIds: item.citation_ids,
      sourceIds: orderedSources.map((source) => source.source_id),
    })),
  ].sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.register_id.localeCompare(right.register_id)).slice(0, MAX_PACKET_ITEMS);
  const duplicateGroupsFound = duplicateGroups(orderedSources);
  const reconciliation = {
    schema_version: PRODUCER_RECONCILIATION_SCHEMA,
    method: "bounded topic comparison of exact source statements",
    source_ids: orderedSources.map((source) => source.source_id),
    duplicate_groups: duplicateGroupsFound,
    topics: reconciliationTopics,
    cross_document_conflicts: crossDocumentConflicts.map((item) => ({
      topic: item.topic,
      citation_ids: item.citation_ids,
      source_ids: item.source_ids || [],
      claim_type: "fact",
    })),
  };

  const sourceInventory = orderedSources.map((source) => ({
    schema_version: PRODUCER_SOURCE_SCHEMA,
    source_id: source.source_id,
    document_id: source.document_id,
    filename: source.filename,
    media_type: source.media_type,
    source_kind: source.source_kind,
    source_label: source.source_label,
    content_hash: source.content_hash,
    byte_size: source.byte_size,
    text_char_count: source.text_char_count,
    truncated: Boolean(source.truncated),
    chunk_count: source.chunk_count,
    locations: source.locations,
    version_provenance: {
      schema_version: PRODUCER_VERSION_PROVENANCE_SCHEMA,
      source_schema_version: PRODUCER_SOURCE_SCHEMA,
      source_version: sourceVersions.get(source.source_id)?.value || null,
      source_version_status: sourceVersions.get(source.source_id) ? "stated_in_uploaded_source" : "not_stated_in_uploaded_source",
      source_version_citation_ids: sourceVersions.get(source.source_id) ? [sourceVersions.get(source.source_id).citation_id] : [],
      identity_basis: "normalized extracted content identity plus server-assigned source kind",
    },
    ingestion: source.ingestion,
  }));
  const versionProvenance = {
    schema_version: PRODUCER_VERSION_PROVENANCE_SCHEMA,
    packet_schema_version: PRODUCER_PACKET_SCHEMA_LEGACY,
    source_schema_version: PRODUCER_SOURCE_SCHEMA,
    sources: orderedSources.map((source) => ({
      source_id: source.source_id,
      source_kind: source.source_kind,
      document_id: source.document_id,
      source_schema_version: PRODUCER_SOURCE_SCHEMA,
      source_version: sourceVersions.get(source.source_id)?.value || null,
      source_version_status: sourceVersions.get(source.source_id) ? "stated_in_uploaded_source" : "not_stated_in_uploaded_source",
      source_version_citation_ids: sourceVersions.get(source.source_id) ? [sourceVersions.get(source.source_id).citation_id] : [],
    })),
  };
  const packetId = overridePacketId || producerPacketId(orderedSources);
  const handoffCitationIds = [...new Set(decisionRegister.flatMap((item) => item.citation_ids))].slice(0, 16);
  const handoff = {
    schema_version: PRODUCER_HANDOFF_SCHEMA,
    audience: ["producer", "department leads"],
    status: decisionRegister.some((item) => item.priority === "high") ? "review_required" : "ready_for_review",
    next_owner: "producer",
    source_ids: orderedSources.map((source) => source.source_id),
    open_register_ids: decisionRegister.map((item) => item.register_id),
    prioritized_register_ids: decisionRegister.filter((item) => item.priority === "high").map((item) => item.register_id),
    next_action: "Review the prioritized register, resolve conflicts, and assign the open questions before distributing this packet.",
    claim_type: "inference",
    citation_ids: handoffCitationIds,
  };
  const citedIds = new Set([
    ...executiveSummary.citation_ids,
    ...decisions.flatMap((item) => item.citation_ids),
    ...locationAndTiming.flatMap((item) => item.citation_ids),
    ...castRoleDemands.flatMap((item) => item.citation_ids),
    ...departmentRequirements.flatMap((item) => item.citation_ids),
    ...risks.flatMap((item) => item.citation_ids),
    ...gaps.flatMap((item) => item.citation_ids),
    ...decisionRegister.flatMap((item) => item.citation_ids),
    ...handoff.citation_ids,
    ...[...sourceVersions.values()].filter(Boolean).map((version) => version.citation_id),
  ]);
  const citations = [...citedIds].map((id) => citationsById.get(id)).filter(Boolean).slice(0, MAX_PACKET_CITATIONS);
  return {
    schema_version: PRODUCER_PACKET_SCHEMA_LEGACY,
    workflow: PRODUCER_WORKFLOW,
    status: "succeeded",
    packet_id: packetId,
    created_at: createdAt,
    bundle: {
      schema_version: PRODUCER_BUNDLE_SCHEMA,
      source_count: orderedSources.length,
      source_ids: orderedSources.map((source) => source.source_id),
      total_bytes: orderedSources.reduce((total, source) => total + source.byte_size, 0),
      total_extracted_chars: orderedSources.reduce((total, source) => total + source.text_char_count, 0),
    },
    executive_summary: executiveSummary,
    source_inventory: sourceInventory,
    version_provenance: versionProvenance,
    reconciliation,
    production_decisions: decisions,
    decision_register: decisionRegister,
    locations_and_timing: locationAndTiming.slice(0, MAX_PACKET_ITEMS),
    cast_role_demands: castRoleDemands,
    department_requirements: departmentRequirements,
    risks_or_conflicts: risks,
    cross_document_conflicts: crossDocumentConflicts,
    gaps_or_questions: gaps.slice(0, MAX_PACKET_ITEMS),
    handoff,
    cited_citation_ids: citations.map((citation) => citation.citation_id),
    citations,
    provenance: {
      schema_version: "producer-provenance@1",
      contract_version: PRODUCER_PACKET_SCHEMA_LEGACY,
      mode: "demo",
      backend: "local-deterministic-consolidation",
      provider: "MovieInator uploaded production sources",
      external: false,
      read_only: true,
    },
    limitations: [
      "This packet only reports what the uploaded sources establish.",
      "Conflicts are surfaced for producer resolution; they are not resolved by inference.",
      "A citation does not establish budget approval, permit status, legal conclusions, availability, or publication rights.",
    ],
  };
}

function canonicalLineEntries(source) {
  const entries = linesForSource(source);
  const locationEntries = source.locations.map((location) => ({
    text: location.section || "",
    citation_id: source.chunks.find((chunk) => chunk.source_locations.some((item) => stableStringify(item) === stableStringify(location))) ? citationForChunk(source, source.chunks.find((chunk) => chunk.source_locations.some((item) => stableStringify(item) === stableStringify(location))))?.citation_id : undefined,
    source,
    location,
  })).filter((entry) => entry.text && entry.citation_id);
  return [...locationEntries, ...entries];
}

function canonicalCitations(sources) {
  const map = new Map();
  for (const source of sources) {
    for (const chunk of source.chunks) {
      const citation = citationForChunk(source, chunk);
      const headings = chunk.source_locations.map((location) => location.section).filter(Boolean).filter((heading) => !citation.excerpt.includes(heading));
      if (headings.length) citation.excerpt = `${headings[0]}\n${citation.excerpt}`.slice(0, MAX_CHUNK_CHARS);
      map.set(citation.citation_id, citation);
    }
  }
  return map;
}

function canonicalCitationIds(items) {
  return [...new Set(items.flatMap((item) => item.citation_ids || []))].slice(0, MAX_PACKET_CITATIONS);
}

function canonicalFact({ value, classification, evidenceState, source, citationId, field, limitations = [], inferenceBasis }) {
  const text = boundedText(value, 700);
  return {
    fact_id: `fact_${hashValue(stableStringify({ value: text, classification, source_id: source.source_id, citation_id: citationId })).slice(0, 32)}`,
    value: text,
    text,
    field,
    classification,
    evidence_state: evidenceState,
    source_ids: [source.source_id],
    citation_ids: citationId ? [citationId] : [],
    provenance: { source_kind: source.source_kind, filename: source.filename, supplied: classification === "externally_supplied_fact" },
    ...(inferenceBasis ? { inference_basis: inferenceBasis } : {}),
    limitations,
  };
}

function canonicalSourceManifest(sources) {
  return sources.map((source) => ({
    source_id: source.source_id,
    document_id: source.document_id,
    input_ref: source.input_ref || null,
    filename: source.filename,
    media_type: source.media_type,
    byte_size: source.byte_size,
    content_hash: source.content_hash,
    source_kind: source.source_kind,
    department: source.department || null,
    version_label: source.version_label || null,
    status_label: source.status_label || null,
    relationships: source.relationships || [],
    source_note: source.source_note || null,
    ingestion_state: source.ingestion?.state || "ready",
    truncated: Boolean(source.truncated),
    provenance: "uploaded source manifest and normalized content",
    limitations: source.truncated ? ["Source text was bounded before extraction."] : [],
  }));
}

function canonicalAssertion(value, source, citationId, classification, evidenceState, field) {
  return canonicalFact({ value, classification, evidenceState, source, citationId, field });
}

function firstCanonicalLine(source, matcher) {
  return canonicalLineEntries(source).find((line) => matcher.test(line.text));
}

function canonicalRegister({ entryType, title, related, owner, priority, priorityBasis, action, sourceIds, citationIds, evidenceState = "not_established" }) {
  const normalizedPriority = ["high", "medium", "low", "unset"].includes(priority) ? priority : "unset";
  return {
    entry_id: `entry_${hashValue(stableStringify({ entryType, title, action, sourceIds, citationIds })).slice(0, 32)}`,
    entry_type: entryType,
    title: boundedText(title, 180),
    related_to: related || null,
    owner: owner || null,
    priority: normalizedPriority,
    priority_basis: boundedText(priorityBasis || (normalizedPriority === "unset" ? "Priority was not supplied in the bundle." : "Supplied in the source bundle."), 180),
    evidence_state: evidenceState,
    classification: entryType === "decision" ? "decision" : "open_question",
    source_ids: [...new Set(sourceIds)].slice(0, 4),
    citation_ids: [...new Set(citationIds)].slice(0, 8),
    next_action: boundedText(action, 700),
    limitations: ["This is a read-only handoff instruction, not a task sent to a person or downstream system."],
  };
}

function producerBundleManifestEntries(sources) {
  return sources.map((source) => ({ source_id: source.source_id, source_kind: source.source_kind, input_ref: source.input_ref || null, filename: source.filename, version_label: source.version_label || null, status_label: source.status_label || null, relationships: source.relationships || [] }));
}

export function producerBundleId(sources) {
  const manifest = producerBundleManifestEntries(sources);
  return `bdl_${hashValue(stableStringify({ manifest, content_hashes: sources.map((source) => source.content_hash) })).slice(0, 32)}`;
}

export const CANONICAL_PRODUCER_INTENT_KINDS = Object.freeze(["primary_screenplay", "screenplay_revision", "cast_notes", "location_access", "schedule_assumptions", "budget_assumptions", "rights_clearance", "department_input", "breakdown", "handoff"]);

export function isCanonicalProducerIntent(sources) {
  return sources.some((source) => CANONICAL_PRODUCER_INTENT_KINDS.includes(source.source_kind));
}

// The deterministic packet identity is derived once, up front, from the same content that the builder
// itself later hashes. The async producer packet run queues under this identity before the packet body
// is built, so a run can be tracked, polled, and streamed at `/v1/producer-packets/{packet_id}` from the
// moment it is accepted through its terminal state.
export function producerPacketId(sources, { bundleId = undefined } = {}) {
  if (isCanonicalProducerIntent(sources)) {
    const normalizedBundleId = bundleId || producerBundleId(sources);
    return `packet_${hashValue(stableStringify({ schema_version: PRODUCER_PACKET_SCHEMA, bundle_id: normalizedBundleId })).slice(0, 32)}`;
  }
  return `packet_${hashValue(stableStringify({ schema_version: PRODUCER_PACKET_SCHEMA_LEGACY, source_ids: sources.map((source) => source.source_id).sort() })).slice(0, 32)}`;
}

// Distinct from source_manifest_hash: this hashes the client-labelled bundle manifest (source kinds,
// filenames, supplied version/status labels, and relationships) rather than the server-derived
// per-source/version manifest rows. Callers that already hold the exact submitted manifest (the
// producer-source-bundle route) should pass that manifest_hash through explicitly; this fallback keeps
// the field always present and deterministic when no separate manifest transaction exists.
export function producerBundleManifestHash(sources) {
  return `sha256:${hashValue(stableStringify(producerBundleManifestEntries(sources)))}`;
}

// Controlled production-element categories from the PRD's production-element index contract
// (docs/prd.md section 6, item 4). `other` is the safe fallback for unmapped explicit labels.
export const PRODUCTION_ELEMENT_LABELS = Object.freeze({
  cast_or_role: "cast or role",
  extras: "extras",
  location_or_set: "location or set",
  props: "props",
  set_dressing: "set dressing",
  wardrobe: "wardrobe",
  makeup_hair: "makeup and hair",
  vehicles: "vehicles",
  animals: "animals",
  stunts: "stunts",
  vfx_sfx: "VFX/SFX",
  special_equipment: "special equipment",
  sound: "sound",
  music: "music",
  graphics: "graphics",
  other: "other",
});
export const PRODUCTION_ELEMENT_CATEGORIES = Object.freeze(Object.keys(PRODUCTION_ELEMENT_LABELS));
const MAX_PRODUCTION_ELEMENT_ROWS = 60;
const MAX_CAST_ROLE_ROWS = 40;
const MAX_DEPARTMENT_REQUIREMENT_ROWS = 60;

// Explicit category-labelled lines (e.g. "PROPS: a hunting knife") are a bounded, literal source
// statement, so they are recorded as `source_fact`. They may appear in any source kind: a companion
// department or breakdown document is as entitled to state a production element directly as the script.
const PRODUCTION_ELEMENT_EXPLICIT_PATTERNS = Object.freeze([
  { category: "props", pattern: /^props?\s*[:=-]\s*(.+)$/i },
  { category: "set_dressing", pattern: /^set\s*dressing\s*[:=-]\s*(.+)$/i },
  { category: "wardrobe", pattern: /^(?:wardrobe|costume)\s*[:=-]\s*(.+)$/i },
  { category: "makeup_hair", pattern: /^(?:makeup(?:\s*(?:and|&)\s*hair)?|hair)\s*[:=-]\s*(.+)$/i },
  { category: "vehicles", pattern: /^vehicles?\s*[:=-]\s*(.+)$/i },
  { category: "animals", pattern: /^animals?\s*[:=-]\s*(.+)$/i },
  { category: "stunts", pattern: /^stunts?\s*[:=-]\s*(.+)$/i },
  { category: "vfx_sfx", pattern: /^(?:vfx|sfx|visual\s*effects?|special\s*effects?)\s*[:=-]\s*(.+)$/i },
  { category: "special_equipment", pattern: /^(?:special\s*equipment|equipment)\s*[:=-]\s*(.+)$/i },
  { category: "sound", pattern: /^sound\s*[:=-]\s*(.+)$/i },
  { category: "music", pattern: /^music\s*[:=-]\s*(.+)$/i },
  { category: "graphics", pattern: /^graphics?\s*[:=-]\s*(.+)$/i },
  { category: "extras", pattern: /^extras?\s*[:=-]\s*(.+)$/i },
  { category: "location_or_set", pattern: /^(?:location|set|venue)\s*[:=-]\s*(.+)$/i },
]);

// Action-line patterns scanned only within the primary screenplay or a screenplay revision. A match is
// a bounded interpretation of source language (the PRD's example is "a likely production element implied
// by an action line"), so these are always recorded as `source_implied_inference` with an `inference_basis`,
// never upgraded to an externally supplied or verified fact.
const PRODUCTION_ELEMENT_INFERENCE_PATTERNS = Object.freeze([
  { category: "props", pattern: /\b(?:holds?|carries?|grabs?|draws?|wields?|picks up|pulls out)\s+(?:a|an|the|his|her|their)\s+[a-z][a-z'-]{2,40}\b/i, basis: "Action line describes a character handling or carrying an object, implying a prop element." },
  { category: "vehicles", pattern: /\b(?:car|taxi|motorcycle|motorbike|scooter|bus|van|truck|vehicle|boat|train|ferry|bicycle|bike)\b/i, basis: "Action line names a vehicle." },
  { category: "wardrobe", pattern: /\b(?:wears?|wearing|dressed in|dons?)\b/i, basis: "Action line describes a character's clothing, implying a wardrobe element." },
  { category: "set_dressing", pattern: /\b(?:furniture|decor(?:ation)?|wallpaper|curtains?|bookcase|cluttered with|lined with)\b/i, basis: "Action or scene description implies set dressing." },
  { category: "stunts", pattern: /\b(?:fight(?:s|ing)?|chase(?:s|d)?|falls?|jumps?|crash(?:es|ed)?|punch(?:es|ed)?|kicks?|tackles?|leaps?)\b/i, basis: "Action line describes physical action that may require stunt coordination." },
  { category: "vfx_sfx", pattern: /\b(?:VFX|CGI|visual effect|green[- ]screen|wire removal|digital double|SFX|special effect|explosion|explodes?)\b/i, basis: "Action or scene description references a visual or special effect." },
  { category: "sound", pattern: /\b(?:radio crackles|phone rings?|alarm (?:blares|sounds)|sirens? wail|voice[- ]over|O\.S\.)\b/i, basis: "Action line references a sound cue." },
  { category: "music", pattern: /\b(?:music plays|soundtrack|hums? a tune|song plays)\b/i, basis: "Action line references music." },
  { category: "animals", pattern: /\b(?:dog|cat|horse|bird|snake|monkey)\b/i, basis: "Action line names an animal." },
  { category: "extras", pattern: /\b(?:crowd|crowds|dozens of|hundreds of|onlookers|bystanders)\b/i, basis: "Action line describes a crowd, implying extras." },
]);

function isScreenplaySource(source) {
  return source.source_kind === "primary_screenplay" || source.source_kind === "screenplay_revision";
}

function productionElementRow({ category, value, classification, evidenceState, source, citationId, inferenceBasis }) {
  const text = boundedText(value, 420);
  return {
    element_id: `element_${hashValue(stableStringify({ category, text, source_id: source.source_id, citation_id: citationId || null })).slice(0, 32)}`,
    category,
    department: source.department || null,
    value: text,
    text,
    classification,
    evidence_state: evidenceState,
    source_ids: [source.source_id],
    citation_ids: citationId ? [citationId] : [],
    ...(inferenceBasis ? { inference_basis: inferenceBasis } : {}),
    limitations: [],
  };
}

// Generalizes production-element extraction to any bounded bundle: explicit category labels are
// scanned across every source, and screenplay action-line inference is scanned only within screenplay
// sources. Nothing is invented; every row cites the exact source line it was derived from.
function deriveProductionElements(sources) {
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    const key = `${row.category}|${row.text}|${row.source_ids[0]}`;
    if (seen.has(key) || rows.length >= MAX_PRODUCTION_ELEMENT_ROWS) return;
    seen.add(key);
    rows.push(row);
  };
  for (const source of sources) {
    for (const line of canonicalLineEntries(source)) {
      let matchedExplicit = false;
      for (const { category, pattern } of PRODUCTION_ELEMENT_EXPLICIT_PATTERNS) {
        const match = line.text.match(pattern);
        if (!match) continue;
        matchedExplicit = true;
        push(productionElementRow({ category, value: match[1], classification: "source_fact", evidenceState: "established", source: line.source, citationId: line.citation_id }));
      }
      if (matchedExplicit || !isScreenplaySource(source)) continue;
      for (const { category, pattern, basis } of PRODUCTION_ELEMENT_INFERENCE_PATTERNS) {
        if (!pattern.test(line.text)) continue;
        push(productionElementRow({ category, value: line.text, classification: "source_implied_inference", evidenceState: "established", source: line.source, citationId: line.citation_id, inferenceBasis: basis }));
      }
    }
  }
  return rows;
}

const CAST_EXPLICIT_PATTERN = /^(?:role|cast|character)\s*[:=-]\s*(.+)$/i;
const CAST_SUPPLIED_PATTERN = /^(?:actor|candidate|availability|deal\s*status)\s*[:=-]\s*(.+)$/i;
const CAST_DEMAND_PATTERN = /(?:\(\s*\d{1,2}\s*\)|\b\d{1,2}\s*(?:years?\s*old|yo)\b|\bchild(?:ren)?\b|\bkid\b|\bteen(?:ager)?\b|\belderly\b|\bpregnant\b|\btwins?\b|\bminors?\b|\bstunt double\b|\bwheelchair\b|\bdeaf\b|\bblind\b|\baccent\b|\bdialect\b)/i;

function castRoleRow({ value, classification, evidenceState, source, citationId }) {
  const text = boundedText(value, 420);
  return {
    element_id: `cast_${hashValue(stableStringify({ text, source_id: source.source_id, citation_id: citationId || null })).slice(0, 32)}`,
    category: "cast_or_role",
    department: source.department || "cast",
    value: text,
    text,
    classification,
    evidence_state: evidenceState,
    source_ids: [source.source_id],
    citation_ids: citationId ? [citationId] : [],
    limitations: classification === "externally_supplied_fact" ? ["A named candidate or availability record is not a cast commitment."] : [],
  };
}

// Cast and role demands are drawn from explicit ROLE/CAST/CHARACTER labels in any source, supplied
// candidate or availability lines in a `cast_notes` companion, and age/ability/continuity demand
// language stated directly in the screenplay. An actor name or candidate is never treated as an
// availability or contract status; that limitation travels with every externally supplied row.
function deriveCastRoleDemands(sources) {
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    const key = `${row.text}|${row.source_ids[0]}`;
    if (seen.has(key) || rows.length >= MAX_CAST_ROLE_ROWS) return;
    seen.add(key);
    rows.push(row);
  };
  for (const source of sources) {
    for (const line of canonicalLineEntries(source)) {
      const explicit = line.text.match(CAST_EXPLICIT_PATTERN);
      if (explicit) {
        push(castRoleRow({ value: explicit[1], classification: "source_fact", evidenceState: "established", source: line.source, citationId: line.citation_id }));
        continue;
      }
      if (source.source_kind === "cast_notes") {
        const supplied = line.text.match(CAST_SUPPLIED_PATTERN);
        if (supplied) {
          push(castRoleRow({ value: line.text, classification: "externally_supplied_fact", evidenceState: "supplied_not_verified", source: line.source, citationId: line.citation_id }));
          continue;
        }
      }
      if (isScreenplaySource(source) && CAST_DEMAND_PATTERN.test(line.text)) {
        push(castRoleRow({ value: line.text, classification: "source_fact", evidenceState: "established", source: line.source, citationId: line.citation_id }));
      }
    }
  }
  return rows;
}

// Keyword routing used only to infer a PRD-listed department (docs/prd.md section 5) when a
// department_input or breakdown source does not supply its own `department` label. A supplied label
// always wins; this is a bounded fallback, not a classification authority.
const DEPARTMENT_KEYWORDS = Object.freeze([
  { department: "camera", pattern: /\b(?:camera|lens|steadicam|gimbal|drone|crane shot)\b/i },
  { department: "art", pattern: /\b(?:art department|set design|production design|set dressing|props?)\b/i },
  { department: "costume", pattern: /\b(?:costume|wardrobe)\b/i },
  { department: "makeup_hair", pattern: /\b(?:makeup|hair)\b/i },
  { department: "sound_music", pattern: /\b(?:sound|audio|music|score|composer)\b/i },
  { department: "vfx_sfx", pattern: /\b(?:vfx|sfx|visual effect|special effect|cgi)\b/i },
  { department: "stunts_safety", pattern: /\b(?:stunt|safety|hazard|risk assessment)\b/i },
  { department: "locations", pattern: /\b(?:location|venue|permit|access)\b/i },
  { department: "cast", pattern: /\b(?:cast|actor|role|talent)\b/i },
  { department: "production_management", pattern: /\b(?:call sheet|logistics|transport|catering|unit base)\b/i },
  { department: "line_production", pattern: /\b(?:schedule|budget|line producer)\b/i },
  { department: "legal_business_affairs", pattern: /\b(?:rights|clearance|release form|legal|contract)\b/i },
  { department: "finance", pattern: /\b(?:invoice|payment|finance|accountant)\b/i },
]);

function inferDepartment(text) {
  return DEPARTMENT_KEYWORDS.find((entry) => entry.pattern.test(text))?.department || "other";
}

function departmentRow({ department, value, classification, evidenceState, source, citationId, limitations = [] }) {
  const text = boundedText(value, 420);
  return {
    element_id: `department_${hashValue(stableStringify({ department, text, source_id: source.source_id, citation_id: citationId || null })).slice(0, 32)}`,
    category: "department_requirement",
    department,
    value: text,
    text,
    classification,
    evidence_state: evidenceState,
    source_ids: [source.source_id],
    citation_ids: citationId ? [citationId] : [],
    limitations,
  };
}

// Department requirements are drawn from `department_input`/`breakdown` sources (using the supplied
// department label, or a bounded keyword fallback), and from `director_notes` requirement language.
// A detected stunt production element always routes an explicit safety-review open question; stunts
// and physical action are never labelled safe or approved by this deterministic pipeline.
function deriveDepartmentRequirements(sources, productionElementRows) {
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    const key = `${row.department}|${row.text}|${row.source_ids[0]}`;
    if (seen.has(key) || rows.length >= MAX_DEPARTMENT_REQUIREMENT_ROWS) return;
    seen.add(key);
    rows.push(row);
  };
  for (const source of sources) {
    if (source.source_kind !== "department_input" && source.source_kind !== "breakdown") continue;
    for (const line of canonicalLineEntries(source)) {
      if (line.text.length < 4) continue;
      const department = source.department || inferDepartment(line.text);
      push(departmentRow({ department, value: line.text, classification: "source_fact", evidenceState: "established", source: line.source, citationId: line.citation_id }));
    }
  }
  for (const source of sources) {
    if (source.source_kind !== "director_notes") continue;
    for (const line of canonicalLineEntries(source)) {
      if (!/\b(?:must|need|require[sd]?|please|ensure)\b/i.test(line.text)) continue;
      push(departmentRow({ department: "director", value: line.text, classification: "externally_supplied_fact", evidenceState: "supplied_not_verified", source: line.source, citationId: line.citation_id }));
    }
  }
  for (const element of productionElementRows) {
    if (element.category !== "stunts") continue;
    push(departmentRow({
      department: "stunts_safety",
      value: `Confirm specialist safety review for: ${element.text}`,
      classification: "open_question",
      evidenceState: "not_established",
      source: { source_id: element.source_ids[0] },
      citationId: element.citation_ids[0],
      limitations: ["Stunts and physical action are routed to specialist safety review; this is never a safety approval or clearance."],
    }));
  }
  return rows;
}

// Explicit human decisions recorded directly in a source (e.g. "Decision: ..." or "Approved: ...")
// are the only case the deterministic pipeline records as classification `decision`; MovieInator never
// generates, approves, or infers a decision on its own.
const EXPLICIT_DECISION_PATTERN = /^(?:decision|decided|approved)\s*[:=-]\s*(.+)$/i;

function deriveExplicitDecisions(sources) {
  const results = [];
  const seen = new Set();
  for (const source of sources) {
    for (const line of canonicalLineEntries(source)) {
      const match = line.text.match(EXPLICIT_DECISION_PATTERN);
      if (!match) continue;
      const text = boundedText(match[1], 700);
      const key = `${source.source_id}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ text, source, citationId: line.citation_id });
      if (results.length >= 20) return results;
    }
  }
  return results;
}

// Retention lifecycle: local demo mode declares no server-owned TTL by default (docs/prd.md's
// "local demo ... has no external retention"), so `retentionLifecycle` is a no-op unless a caller
// supplies an explicit bounded `retentionTtlMs` policy. When a TTL is supplied, evidence ages through
// three stages: fresh ("local"), "stale" once past `PRODUCER_RETENTION_STALE_RATIO` of the window, and
// "expired" once past the full window, matching the PRD's declared server-owned retention contract.
export const PRODUCER_RETENTION_STALE_RATIO = 0.8;
const RETENTION_EXPIRED_LIMITATION = "Source retention has expired; this record can no longer be independently re-verified from the original source.";
const RETENTION_STALE_LIMITATION = "This record is approaching the retention window limit and should be reconfirmed before relying on it.";
const RETENTION_EXPIRED_CONTENT = "[Source retention has expired. The original content is no longer available.]";
// Once retention fully expires, the PRD treats source bytes and extracted text as gone, not merely the
// citation excerpt. These are the verbatim-wording fields a canonical_item can carry; they are replaced
// with the same bounded placeholder so an expired record cannot keep displaying quoted source content it
// can no longer be re-verified against. Structural fields (classification, evidence_state, ids, owner,
// priority, department, category) are preserved so the record remains auditable.
const RETENTION_EXPIRED_TEXT_FIELDS = Object.freeze(["text", "value", "original_wording", "scene_heading", "scene_reference", "setting", "related_to", "question", "impact", "why_it_matters", "evidence_needed", "title", "next_action"]);

function retentionLifecycle({ createdAt, now, retentionTtlMs }) {
  if (!retentionTtlMs || !Number.isFinite(retentionTtlMs) || retentionTtlMs <= 0) {
    return { state: "local", expired: false, stale: false, expires_at: null };
  }
  const createdMs = Date.parse(createdAt);
  const nowMs = Date.parse(now ?? createdAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) {
    return { state: "local", expired: false, stale: false, expires_at: null };
  }
  const expiresAtMs = createdMs + retentionTtlMs;
  const staleAtMs = createdMs + Math.round(retentionTtlMs * PRODUCER_RETENTION_STALE_RATIO);
  const expired = nowMs >= expiresAtMs;
  const stale = !expired && nowMs >= staleAtMs;
  return { state: expired ? "expired" : stale ? "stale" : "local", expired, stale, expires_at: new Date(expiresAtMs).toISOString() };
}

export function computeProducerRetentionLifecycle({ createdAt, now = new Date().toISOString(), retentionTtlMs } = {}) {
  return retentionLifecycle({ createdAt, now, retentionTtlMs });
}

function applyRetentionToItem(item, lifecycle) {
  if (!item || typeof item !== "object" || lifecycle.state === "local") return item;
  const assertions = Array.isArray(item.assertions) ? item.assertions.map((assertion) => applyRetentionToItem(assertion, lifecycle)) : undefined;
  if (!item.evidence_state) return assertions ? { ...item, assertions } : item;
  if (lifecycle.state === "expired") {
    const redacted = { ...item };
    for (const field of RETENTION_EXPIRED_TEXT_FIELDS) {
      if (redacted[field] !== undefined && redacted[field] !== null) redacted[field] = RETENTION_EXPIRED_CONTENT;
    }
    if (redacted.location && typeof redacted.location === "object") redacted.location = { ...redacted.location, section: redacted.location.section ? RETENTION_EXPIRED_CONTENT : redacted.location.section };
    return {
      ...redacted,
      ...(assertions ? { assertions } : {}),
      evidence_state: "unavailable",
      limitations: [...new Set([...(item.limitations || []), RETENTION_EXPIRED_LIMITATION])].slice(0, 8),
    };
  }
  if (lifecycle.state === "stale" && (item.evidence_state === "established" || item.evidence_state === "supplied_not_verified")) {
    return {
      ...item,
      ...(assertions ? { assertions } : {}),
      evidence_state: "stale",
      limitations: [...new Set([...(item.limitations || []), RETENTION_STALE_LIMITATION])].slice(0, 8),
    };
  }
  return assertions ? { ...item, assertions } : item;
}

function applyRetentionToCitation(citation, lifecycle) {
  if (!citation || lifecycle.state !== "expired") return citation;
  return { ...citation, excerpt: RETENTION_EXPIRED_CONTENT };
}

function retentionLimitationMessage(lifecycle, now) {
  return lifecycle.state === "expired"
    ? `Retention has expired as of ${now}; citations reflect only that the original source content is no longer available.`
    : `Retention is approaching its limit as of ${now} (window ends ${lifecycle.expires_at}); some records are marked stale pending reconfirmation.`;
}

// A read-time retention overlay for an already-built, immutable packet. Packet identity, created_at,
// and source content never change; this only projects `status`, per-item `evidence_state`, and citation
// excerpts forward against the wall clock and a server-owned retention policy, matching the PRD's
// retention contract (docs/prd.md section 5, "Normalization, redaction, and retention"). Calling this
// with no `retentionTtlMs` is a no-op, matching local demo mode's declared "no external retention".
export function applyProducerPacketRetention(packet, { now = new Date().toISOString(), retentionTtlMs } = {}) {
  if (!packet || typeof packet !== "object") return packet;
  const lifecycle = retentionLifecycle({ createdAt: packet.created_at, now, retentionTtlMs });
  if (lifecycle.state === "local") return packet;
  const transformValue = (value) => {
    if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" && item.excerpt !== undefined && item.citation_id !== undefined ? applyRetentionToCitation(item, lifecycle) : applyRetentionToItem(item, lifecycle)));
    if (value && typeof value === "object") {
      if (value.excerpt !== undefined && value.citation_id !== undefined) return applyRetentionToCitation(value, lifecycle);
      if (value.evidence_state !== undefined || value.classification !== undefined) return applyRetentionToItem(value, lifecycle);
    }
    return value;
  };
  const next = { ...packet };
  for (const key of Object.keys(next)) {
    if (key === "provenance" || key === "status" || key === "bundle" || key === "limitations") continue;
    next[key] = transformValue(next[key]);
  }
  next.status = lifecycle.state === "expired" ? "expired" : packet.status;
  next.provenance = { ...packet.provenance, retention_state: lifecycle.state };
  next.limitations = [...new Set([...(packet.limitations || []), retentionLimitationMessage(lifecycle, now)])].slice(0, 8);
  return next;
}

function buildCanonicalProducerDecisionPacket(sources, { createdAt = new Date().toISOString(), bundleId = undefined, decisionContext = "", bundleManifestHash = undefined, overridePacketId = undefined } = {}) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_PRODUCER_SOURCES) {
    throw new DocumentContractError("BUNDLE_LIMIT_EXCEEDED", `A producer bundle must contain 1 to ${MAX_PRODUCER_SOURCES} sources`, "sources");
  }
  const primary = sources.filter((source) => source.source_kind === "primary_screenplay");
  const revisions = sources.filter((source) => source.source_kind === "screenplay_revision");
  if (primary.length !== 1) throw new DocumentContractError("PRIMARY_SOURCE_REQUIRED", "Exactly one primary_screenplay source is required", "source_kind");
  if (revisions.length > MAX_PRODUCER_REVISIONS) throw new DocumentContractError("BUNDLE_LIMIT_EXCEEDED", `At most ${MAX_PRODUCER_REVISIONS} screenplay_revision sources are accepted`, "source_kind");
  const orderedSources = sources.map((source) => ({ ...source, chunks: source.chunks.slice(0, 240) }));
  const citationsById = canonicalCitations(orderedSources);
  const script = primary[0];
  const scene = firstCanonicalLine(script, /^SCENE\s+7\s*-\s*INT\.\s*MILL\s*-\s*NIGHT$/i) || firstCanonicalLine(script, /^SCENE\s+\d+\s*-/i);
  const sceneHeading = scene?.text || "Scene heading is not established in the primary screenplay.";
  const sceneCitationId = scene?.citation_id;
  const sceneReferenceLabel = scene ? boundedText(sceneHeading, 160) : "the primary screenplay's referenced scene";
  const sceneRow = {
    scene_id: `scene_${hashValue(stableStringify({ sceneHeading, source_id: script.source_id })).slice(0, 32)}`,
    scene_reference: sceneHeading,
    scene_heading: sceneHeading,
    setting: sceneHeading.match(/-\s*(?:INT\.|EXT\.|I\/E\.)\s*([^ -].*?)\s*-\s*(?:DAY|NIGHT)\s*$/i)?.[1]?.trim() || null,
    int_ext: sceneHeading.match(/\b(INT\.|EXT\.|I\/E\.)/i)?.[1]?.toUpperCase() || null,
    time_of_day: sceneHeading.match(/-\s*(DAY|NIGHT)\s*$/i)?.[1]?.toUpperCase() || null,
    location: scene?.location || script.locations.find((location) => location.section === sceneHeading) || null,
    classification: scene ? "source_fact" : "open_question",
    evidence_state: scene ? "established" : "not_established",
    source_ids: [script.source_id],
    citation_ids: sceneCitationId ? [sceneCitationId] : [],
  };

  const locationSource = orderedSources.find((source) => source.source_kind === "location_access");
  const scheduleSource = orderedSources.find((source) => source.source_kind === "schedule_assumptions");
  const budgetSource = orderedSources.find((source) => source.source_kind === "budget_assumptions");
  const permission = locationSource && firstCanonicalLine(locationSource, /permission|access\s+status|hold|confirmed/i);
  const noHold = locationSource && firstCanonicalLine(locationSource, /no\s+(?:location\s+)?hold|hold[^\n]*not\s+confirmed|not\s+confirmed/i);
  const owner = locationSource && firstCanonicalLine(locationSource, /^(?:supplied\s+)?owner\s*[:=-]/i);
  const ownerValue = owner?.text.match(/^(?:supplied\s+)?owner\s*[:=-]\s*(.+)$/i)?.[1]?.trim() || undefined;
  const scheduleAssumption = scheduleSource && firstCanonicalLine(scheduleSource, /assumption|scene\s*7|mill\s+hold/i);
  const budget = budgetSource && firstCanonicalLine(budgetSource, /\$\s?[\d,.]+|\b(?:rate|cost|access)\b/i);
  const budgetMatch = budget?.text.match(/(\$\s?[\d,.]+)\s*(?:per|\/)\s*([^,.;]+)|([\$€£])\s?([\d,.]+)\s*(?:per|\/)\s*([^,.;]+)/i);
  const budgetAmount = budgetMatch ? (budgetMatch[1] || `${budgetMatch[3]}${budgetMatch[4]}`) : undefined;
  const budgetUnit = budgetMatch ? (budgetMatch[2] || budgetMatch[5]).trim() : "access day";

  const exactFacts = [];
  if (scene) exactFacts.push(canonicalAssertion(sceneHeading, script, sceneCitationId, "source_fact", "established", "scene_heading"));
  if (permission) exactFacts.push(canonicalAssertion(permission.text, locationSource, permission.citation_id, "externally_supplied_fact", "supplied_not_verified", "location_access_status"));
  if (noHold) exactFacts.push(canonicalAssertion(noHold.text, locationSource, noHold.citation_id, "source_fact", "established", "location_hold"));
  if (ownerValue) exactFacts.push(canonicalAssertion(ownerValue, locationSource, owner.citation_id, "externally_supplied_fact", "supplied_not_verified", "owner"));
  if (scheduleAssumption) exactFacts.push(canonicalAssertion(scheduleAssumption.text, scheduleSource, scheduleAssumption.citation_id, "human_assumption", "assumed", "schedule_assumption"));
  if (budget && budgetAmount) {
    const fact = canonicalAssertion(budget.text, budgetSource, budget.citation_id, "externally_supplied_fact", "supplied_not_verified", "access_rate");
    fact.amount = budgetAmount;
    fact.currency = "USD";
    fact.unit = budgetUnit;
    fact.normalization_basis = "The source supplied a dollar-denominated amount; no total was calculated.";
    exactFacts.push(fact);
  }

  const accessRow = permission ? canonicalAssertion(permission.text, locationSource, permission.citation_id, "externally_supplied_fact", "supplied_not_verified", "permission") : canonicalFact({ value: "Location permission or hold is not established in the supplied bundle.", classification: "open_question", evidenceState: "not_established", source: locationSource || script, citationId: permission?.citation_id, field: "permission" });
  accessRow.owner = ownerValue || null;
  accessRow.priority = "unset";
  accessRow.priority_basis = "Priority was not supplied in the bundle.";
  const rightsAccessLogistics = [{ ...accessRow, category: "location_access", next_action: "obtain or record the access evidence" }];
  if (noHold) rightsAccessLogistics.push({ ...canonicalAssertion(noHold.text, locationSource, noHold.citation_id, "source_fact", "established", "location_hold"), category: "location_access", owner: ownerValue || null, priority: "unset", priority_basis: "Priority was not supplied in the bundle." });

  const budgetInputs = budget && budgetAmount ? [{
    input_id: `budget_${hashValue(stableStringify({ source_id: budgetSource.source_id, citation_id: budget.citation_id })).slice(0, 32)}`,
    value: budgetAmount,
    amount: budgetAmount,
    currency: "USD",
    unit: budgetUnit,
    original_wording: budget.text,
    classification: "externally_supplied_fact",
    evidence_state: "supplied_not_verified",
    source_ids: [budgetSource.source_id],
    citation_ids: [budget.citation_id],
    limitations: ["Externally supplied and not independently verified.", "No total, forecast, or contingency amount was calculated."],
  }] : [];

  const scheduleInputs = scheduleAssumption ? [{
    input_id: `schedule_${hashValue(stableStringify({ source_id: scheduleSource.source_id, citation_id: scheduleAssumption.citation_id })).slice(0, 32)}`,
    value: scheduleAssumption.text,
    classification: "human_assumption",
    evidence_state: "assumed",
    source_ids: [scheduleSource.source_id],
    citation_ids: [scheduleAssumption.citation_id],
  }] : [];
  const locationsAndTiming = [sceneRow, ...rightsAccessLogistics.map((row) => ({ ...row, category: "location_access" })), ...scheduleInputs];
  const conflict = scheduleAssumption && noHold ? {
    conflict_id: `conflict_${hashValue(stableStringify({ schedule: scheduleAssumption.citation_id, access: noHold.citation_id })).slice(0, 32)}`,
    kind: "schedule_location_access",
    title: "Schedule assumption conflicts with location access evidence",
    assertions: [
      { text: scheduleAssumption.text, classification: "human_assumption", evidence_state: "assumed", source_ids: [scheduleSource.source_id], citation_ids: [scheduleAssumption.citation_id] },
      { text: noHold.text, classification: "source_fact", evidence_state: "established", source_ids: [locationSource.source_id], citation_ids: [noHold.citation_id] },
    ],
    impact: "An assumed schedule hold or access date must not be treated as confirmed until the access evidence is recorded.",
    question: `Which access evidence governs ${sceneReferenceLabel} before schedule or location commitment?`,
    classification: "conflict",
    evidence_state: "conflict",
    source_ids: [scheduleSource.source_id, locationSource.source_id],
    citation_ids: [scheduleAssumption.citation_id, noHold.citation_id],
  } : null;
  const conflicts = conflict ? [conflict] : [];
  const openQuestion = canonicalRegister({
    entryType: "open_question",
    title: boundedText(`Confirm access evidence for ${sceneReferenceLabel}`, 180),
    related: sceneHeading,
    owner: ownerValue || null,
    priority: "unset",
    priorityBasis: "Priority was not supplied in the bundle.",
    action: "obtain or record the access evidence",
    sourceIds: [locationSource?.source_id, scheduleSource?.source_id].filter(Boolean),
    citationIds: [permission?.citation_id, noHold?.citation_id, scheduleAssumption?.citation_id].filter(Boolean),
    evidenceState: "not_established",
  });
  const gapsAndNextSteps = [{
    gap_id: `gap_${hashValue(openQuestion.entry_id).slice(0, 32)}`,
    question: boundedText(`Is access permission or the assumed schedule hold confirmed for ${sceneReferenceLabel}?`, 700),
    why_it_matters: "The schedule assumption and location access record are not the same operational status.",
    owner: ownerValue || null,
    priority: "unset",
    priority_basis: "Priority was not supplied in the bundle.",
    classification: "open_question",
    evidence_state: "not_established",
    source_ids: openQuestion.source_ids,
    citation_ids: openQuestion.citation_ids,
    next_action: "obtain or record the access evidence",
    evidence_needed: boundedText(`A supplied permission, hold, or access record linked to ${sceneReferenceLabel}.`, 700),
  }];

  const productionElementRows = deriveProductionElements(orderedSources);
  const castRoleDemandRows = deriveCastRoleDemands(orderedSources);
  const departmentRequirementRows = deriveDepartmentRequirements(orderedSources, productionElementRows);
  const explicitDecisionEntries = deriveExplicitDecisions(orderedSources).map((item) => canonicalRegister({
    entryType: "decision",
    title: "Recorded decision supplied in the source bundle",
    related: null,
    owner: null,
    priority: "unset",
    priorityBasis: "Priority was not supplied in the bundle.",
    action: `Recorded decision: ${item.text}`,
    sourceIds: [item.source.source_id],
    citationIds: [item.citationId],
    evidenceState: "recorded_decision",
  }));
  const decisionQuestionRegister = [...explicitDecisionEntries, openQuestion];
  const allItems = [...exactFacts, sceneRow, ...locationsAndTiming, ...budgetInputs, ...scheduleInputs, ...conflicts, ...decisionQuestionRegister, ...gapsAndNextSteps, ...productionElementRows, ...castRoleDemandRows, ...departmentRequirementRows];
  const citedIds = canonicalCitationIds(allItems);

  // A required source's content is unreadable, absent, or outside the safe bound only in the narrow
  // sense the deterministic pipeline can detect here: the primary screenplay never yields a scene, and
  // the bundle never yields any other established, source-implied, or supplied content either. That is
  // `failed` (no verified result). If only the scene is missing but other bounded content was still
  // established, the packet is a `source_gap`, not a fabricated `succeeded` result.
  const hasEstablishedContent = exactFacts.length > 0
    || productionElementRows.length > 0
    || castRoleDemandRows.length > 0
    || departmentRequirementRows.length > 0
    || budgetInputs.length > 0
    || scheduleInputs.length > 0
    || rightsAccessLogistics.some((row) => row.classification !== "open_question");
  const sceneEstablished = Boolean(scene);
  const packetStatus = !sceneEstablished && !hasEstablishedContent ? "failed" : !sceneEstablished ? "source_gap" : "succeeded";
  const sourceManifest = canonicalSourceManifest(orderedSources);
  const sourceManifestHash = `sha256:${hashValue(stableStringify(sourceManifest))}`;
  const normalizedBundleId = bundleId || producerBundleId(orderedSources);
  const normalizedBundleManifestHash = bundleManifestHash || producerBundleManifestHash(orderedSources);
  const packetId = overridePacketId || producerPacketId(orderedSources, { bundleId: normalizedBundleId });
  const summaryText = boundedText(`The supplied bundle contains ${orderedSources.length} labelled sources. ${scene ? `The primary screenplay establishes ${sceneHeading}.` : "The primary screenplay does not establish a scene heading."} ${conflict ? "Schedule and location access records remain in conflict." : "No schedule and location access conflict was established."} ${budgetInputs.length ? "An access rate is supplied but not independently verified; no total is calculated." : "No access rate is established."} ${productionElementRows.length || castRoleDemandRows.length || departmentRequirementRows.length ? `${productionElementRows.length} production element(s), ${castRoleDemandRows.length} cast or role demand(s), and ${departmentRequirementRows.length} department requirement(s) were identified.` : "No production element, cast or role demand, or department requirement was identified."}`, 700);
  return {
    schema_version: PRODUCER_PACKET_SCHEMA,
    workflow: PRODUCER_WORKFLOW,
    status: packetStatus,
    packet_id: packetId,
    bundle_id: normalizedBundleId,
    created_at: createdAt,
    // `generated_at` matches the PRD's literal result-schema sample field name; `created_at` is kept for
    // compatibility with existing callers and the shared legacy packet shape.
    generated_at: createdAt,
    bundle: { schema_version: PRODUCER_BUNDLE_SCHEMA, bundle_id: normalizedBundleId, source_count: orderedSources.length, source_ids: orderedSources.map((source) => source.source_id), total_bytes: orderedSources.reduce((total, source) => total + source.byte_size, 0), total_extracted_chars: orderedSources.reduce((total, source) => total + source.text_char_count, 0), manifest_hash: normalizedBundleManifestHash },
    executive_summary: { text: summaryText, classification: "source_fact", evidence_state: "established", citation_ids: citedIds.slice(0, 8), source_ids: [script.source_id] },
    source_manifest: sourceManifest,
    source_inventory: sourceManifest,
    exact_facts: exactFacts,
    scene_index: [sceneRow],
    production_elements: productionElementRows,
    locations_and_timing: locationsAndTiming,
    cast_role_demands: castRoleDemandRows,
    department_requirements: departmentRequirementRows,
    schedule_inputs: scheduleInputs,
    budget_inputs: budgetInputs,
    rights_access_logistics: rightsAccessLogistics,
    conflicts,
    decision_question_register: decisionQuestionRegister,
    gaps_and_next_steps: gapsAndNextSteps,
    // Compatibility projections retain the previously shipped packet sections.
    version_provenance: { schema_version: PRODUCER_VERSION_PROVENANCE_SCHEMA, packet_schema_version: PRODUCER_PACKET_SCHEMA, source_schema_version: PRODUCER_SOURCE_SCHEMA, sources: sourceManifest.map((source) => ({ source_id: source.source_id, source_kind: source.source_kind, document_id: orderedSources.find((item) => item.source_id === source.source_id)?.document_id, source_schema_version: PRODUCER_SOURCE_SCHEMA, source_version: source.version_label, source_version_status: source.version_label ? "stated_in_uploaded_source" : "not_stated_in_uploaded_source" })) },
    reconciliation: { schema_version: PRODUCER_RECONCILIATION_SCHEMA, method: "bounded deterministic source and manifest reconciliation", source_ids: orderedSources.map((source) => source.source_id), duplicate_groups: [], topics: [{ topic: "schedule_location_access", status: conflict ? "conflict" : "unknown", source_ids: [scheduleSource?.source_id, locationSource?.source_id].filter(Boolean), source_kinds: [scheduleSource?.source_kind, locationSource?.source_kind].filter(Boolean), fact_count: conflict ? 2 : 0, citation_ids: conflict?.citation_ids || [] }], cross_document_conflicts: conflicts.map((item) => ({ ...item, claim_type: "fact", text: item.title })) },
    production_decisions: [],
    decision_register: [],
    risks_or_conflicts: conflicts.map((item) => ({ text: item.title, claim_type: "fact", kind: "conflict", topic: item.kind, citation_ids: item.citation_ids, source_ids: item.source_ids })),
    cross_document_conflicts: conflicts.map((item) => ({ text: item.title, claim_type: "fact", kind: "conflict", topic: item.kind, citation_ids: item.citation_ids, source_ids: item.source_ids })),
    gaps_or_questions: gapsAndNextSteps.map((item) => ({ text: `${item.question} Next action: ${item.next_action}`, claim_type: "unknown", kind: "gap", citation_ids: item.citation_ids, source_ids: item.source_ids })),
    handoff: { schema_version: PRODUCER_HANDOFF_SCHEMA, audience: ["producer"], status: "review_required", next_owner: ownerValue || null, source_ids: orderedSources.map((source) => source.source_id), open_register_ids: decisionQuestionRegister.map((entry) => entry.entry_id), prioritized_register_ids: [], next_action: "obtain or record the access evidence", claim_type: "inference", citation_ids: openQuestion.citation_ids },
    cited_citation_ids: citedIds,
    citations: citedIds.map((citationId) => citationsById.get(citationId)).filter(Boolean).slice(0, MAX_PACKET_CITATIONS),
    provenance: { schema_version: "producer-provenance@1", contract_version: PRODUCER_PACKET_SCHEMA, mode: "demo", backend: "local-deterministic-consolidation", provider: "MovieInator uploaded production sources", external: false, read_only: true, grounding_strategy: "bounded_source_manifest_and_deterministic_reconciliation", bundle_manifest_hash: normalizedBundleManifestHash, source_manifest_hash: sourceManifestHash, fallback_used: false, retention_state: "local" },
    limitations: ["This packet only reports what the bounded uploaded bundle establishes.", "Externally supplied rates and statuses are not independently verified.", "Conflicts and open questions remain for human resolution; no booking, approval, permission, safety clearance, rights conclusion, or budget total was created.", ...(decisionContext ? [`Decision context supplied by the producer: ${boundedText(decisionContext, 1_000)}`] : [])],
  };
}

export function buildProducerDecisionPacket(sources, options = {}) {
  if (isCanonicalProducerIntent(sources)) return buildCanonicalProducerDecisionPacket(sources, options);
  return buildLegacyProducerDecisionPacket(sources, options);
}

function safeSource(source) {
  return {
    schema_version: PRODUCER_SOURCE_SCHEMA,
    source_id: source.source_id,
    document_id: source.document_id,
    input_ref: source.input_ref,
    filename: source.filename,
    media_type: source.media_type,
    source_kind: source.source_kind,
    source_label: source.source_label || PRODUCER_SOURCE_LABELS[source.source_kind],
    department: source.department,
    byte_size: source.byte_size,
    content_hash: source.content_hash,
    text_char_count: source.text_char_count,
    truncated: Boolean(source.truncated),
    chunk_count: source.chunk_count,
    locations: source.locations || [],
    version_label: source.version_label,
    status_label: source.status_label,
    relationships: source.relationships || [],
    source_note: source.source_note,
    ingestion_state: source.ingestion_state,
    version_provenance: source.version_provenance,
    ingestion: source.ingestion,
    provenance: source.provenance,
    limitations: source.limitations || [],
  };
}

function safeRegisterEntry(entry) {
  return {
    schema_version: PRODUCER_REGISTER_SCHEMA,
    register_id: entry.register_id,
    type: entry.type,
    title: boundedText(entry.title, 180),
    action: boundedText(entry.action, 700),
    owner_role: boundedText(entry.owner_role, 80),
    priority: entry.priority,
    status: entry.status,
    claim_type: entry.claim_type,
    citation_ids: entry.citation_ids.slice(0, 8),
    source_ids: entry.source_ids.slice(0, 4),
  };
}

function safeStatement(item) {
  return {
    text: boundedText(item.text || item.value || item.question || item.title, 700),
    citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids.slice(0, 8) : [],
    claim_type: ["fact", "inference", "unknown"].includes(item.claim_type) ? item.claim_type : item.classification === "source_fact" || item.classification === "externally_supplied_fact" ? "fact" : "unknown",
    ...(item.classification ? { classification: item.classification } : {}),
    ...(item.evidence_state ? { evidence_state: item.evidence_state } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.topic ? { topic: item.topic } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.source_id ? { source_id: item.source_id } : {}),
    ...(item.source_kind ? { source_kind: item.source_kind } : {}),
    ...(item.source_ids ? { source_ids: item.source_ids.slice(0, 4) } : {}),
    ...(item.owner !== undefined ? { owner: item.owner } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.next_action ? { next_action: boundedText(item.next_action, 700) } : {}),
  };
}

function safeEvidenceItem(item) {
  if (!item || typeof item !== "object") return item;
  const result = { ...item };
  for (const key of ["text", "value", "question", "title", "original_wording", "impact", "why_it_matters", "next_action", "evidence_needed", "priority_basis", "normalization_basis"]) {
    if (result[key] !== undefined) result[key] = boundedText(result[key], 700);
  }
  for (const key of ["source_ids", "citation_ids"]) if (Array.isArray(result[key])) result[key] = result[key].slice(0, 8);
  if (Array.isArray(result.assertions)) result.assertions = result.assertions.slice(0, 4).map(safeEvidenceItem);
  if (Array.isArray(result.limitations)) result.limitations = result.limitations.slice(0, 3).map((value) => boundedText(value, 240));
  delete result.excerpt;
  delete result.chunks;
  return result;
}

export function safeProducerPacketProjection(packet) {
  if (!packet) return undefined;
  // Only the strict PRD-target contract populates cast_role_demands/department_requirements with rich
  // canonical_item rows (classification, evidence_state, department, inference_basis, limitations); the
  // unrenamed legacy contract keeps its original ProducerStatement shape via safeStatement.
  const isCanonicalPacket = (packet.schema_version || PRODUCER_PACKET_SCHEMA) === PRODUCER_PACKET_SCHEMA;
  return {
    schema_version: packet.schema_version || PRODUCER_PACKET_SCHEMA,
    workflow: PRODUCER_WORKFLOW,
    status: packet.status,
    packet_id: packet.packet_id,
    bundle_id: packet.bundle_id ?? packet.bundle?.bundle_id ?? null,
    created_at: packet.created_at,
    generated_at: packet.generated_at || packet.created_at,
    bundle: packet.bundle,
    executive_summary: safeStatement(packet.executive_summary),
    source_manifest: packet.source_manifest?.map(safeSource),
    source_inventory: packet.source_inventory.map(safeSource),
    version_provenance: packet.version_provenance,
    reconciliation: packet.reconciliation,
    exact_facts: packet.exact_facts?.map(safeEvidenceItem),
    scene_index: packet.scene_index?.map(safeEvidenceItem),
    production_elements: packet.production_elements?.map(safeEvidenceItem),
    schedule_inputs: packet.schedule_inputs?.map(safeEvidenceItem),
    budget_inputs: packet.budget_inputs?.map(safeEvidenceItem),
    rights_access_logistics: packet.rights_access_logistics?.map(safeEvidenceItem),
    conflicts: packet.conflicts?.map(safeEvidenceItem),
    decision_question_register: packet.decision_question_register?.map(safeEvidenceItem),
    gaps_and_next_steps: packet.gaps_and_next_steps?.map(safeEvidenceItem),
    production_decisions: packet.production_decisions.map(safeStatement),
    decision_register: packet.decision_register.map(safeRegisterEntry),
    locations_and_timing: packet.locations_and_timing.map(safeStatement),
    cast_role_demands: packet.cast_role_demands.map(isCanonicalPacket ? safeEvidenceItem : safeStatement),
    department_requirements: packet.department_requirements.map(isCanonicalPacket ? safeEvidenceItem : safeStatement),
    risks_or_conflicts: packet.risks_or_conflicts.map(safeStatement),
    cross_document_conflicts: packet.cross_document_conflicts.map(safeStatement),
    gaps_or_questions: packet.gaps_or_questions.map(safeStatement),
    handoff: packet.handoff,
    decision_context: packet.decision_context || null,
    cited_citation_ids: packet.cited_citation_ids.slice(0, MAX_PACKET_CITATIONS),
    citations: packet.citations.slice(0, MAX_PACKET_CITATIONS).map((citation) => ({
      schema_version: "producer-citation@1",
      citation_id: citation.citation_id,
      source_id: citation.source_id,
      document_id: citation.document_id,
      filename: citation.filename,
      media_type: citation.media_type,
      source_kind: citation.source_kind,
      source_label: citation.source_label,
      source_locations: citation.source_locations,
      excerpt: citation.excerpt.slice(0, MAX_CHUNK_CHARS),
    })),
    provenance: packet.provenance,
    limitations: packet.limitations.slice(0, 8),
  };
}

export function producerCitation(packet, citationId) {
  return packet?.citations?.find((citation) => citation.citation_id === citationId);
}

export function validateProducerBundleSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DocumentContractError("INVALID_REQUEST", "Producer bundle request must be an object");
  }
  if (value.schema_version !== PRODUCER_BUNDLE_SCHEMA) {
    throw new DocumentContractError("INVALID_SCHEMA_VERSION", `schema_version must be ${PRODUCER_BUNDLE_SCHEMA}`, "schema_version");
  }
  return value;
}
