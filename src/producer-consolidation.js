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
export const PRODUCER_PACKET_SCHEMA = "producer-decision-packet@1";
export const PRODUCER_WORKFLOW = "producer_consolidation";
export const PRODUCER_RECONCILIATION_SCHEMA = "producer-reconciliation@1";
export const PRODUCER_REGISTER_SCHEMA = "producer-register-entry@1";
export const PRODUCER_HANDOFF_SCHEMA = "producer-handoff@1";
export const PRODUCER_VERSION_PROVENANCE_SCHEMA = "producer-version-provenance@1";
export const MAX_PRODUCER_SOURCES = 8;
export const MAX_PRODUCER_BUNDLE_BYTES = MAX_DOCUMENT_BYTES * MAX_PRODUCER_SOURCES + 128 * 1024;
export const MAX_PACKET_CITATIONS = 128;
export const MAX_PACKET_ITEMS = 24;

export const PRODUCER_SOURCE_LABELS = Object.freeze({
  script: "Script",
  director_notes: "Director notes",
  cast_actor_notes: "Cast or actor notes",
  location_production_notes: "Location or production notes",
  schedule: "Schedule",
  budget: "Budget",
  department_notes: "Department notes",
  other: "Other production source",
});

export const PRODUCER_SOURCE_KINDS = Object.freeze(Object.keys(PRODUCER_SOURCE_LABELS));

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

function sourceId(document, kind) {
  return `source_${hashValue(stableStringify({ document_id: document.document_id, source_kind: kind })).slice(0, 32)}`;
}

export function parseProducerSource({ filename, contentType, bytes, source_kind }) {
  const kind = sourceKind(source_kind);
  const document = parseGroundingDocument({ filename, contentType, bytes });
  const id = sourceId(document, kind);
  return {
    ...document,
    schema_version: PRODUCER_SOURCE_SCHEMA,
    source_id: id,
    source_kind: kind,
    source_label: PRODUCER_SOURCE_LABELS[kind],
    extracted_text: document.chunks.map((chunk) => chunk.excerpt).join("\n\n").slice(0, MAX_EXTRACTED_CHARS),
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

export function buildProducerDecisionPacket(sources, { createdAt = new Date().toISOString() } = {}) {
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
    packet_schema_version: PRODUCER_PACKET_SCHEMA,
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
  const packetId = `packet_${hashValue(stableStringify({ schema_version: PRODUCER_PACKET_SCHEMA, source_ids: orderedSources.map((source) => source.source_id).sort() })).slice(0, 32)}`;
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
    schema_version: PRODUCER_PACKET_SCHEMA,
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
      mode: "demo",
      backend: "local-deterministic-consolidation",
      provider: "MovieNator uploaded production sources",
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

function safeSource(source) {
  return {
    schema_version: PRODUCER_SOURCE_SCHEMA,
    source_id: source.source_id,
    document_id: source.document_id,
    filename: source.filename,
    media_type: source.media_type,
    source_kind: source.source_kind,
    source_label: source.source_label,
    byte_size: source.byte_size,
    text_char_count: source.text_char_count,
    truncated: Boolean(source.truncated),
    chunk_count: source.chunk_count,
    locations: source.locations,
    version_provenance: source.version_provenance,
    ingestion: source.ingestion,
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
    text: boundedText(item.text, 700),
    citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids.slice(0, 8) : [],
    claim_type: ["fact", "inference", "unknown"].includes(item.claim_type) ? item.claim_type : "unknown",
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.topic ? { topic: item.topic } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.source_id ? { source_id: item.source_id } : {}),
    ...(item.source_kind ? { source_kind: item.source_kind } : {}),
    ...(item.source_ids ? { source_ids: item.source_ids.slice(0, 4) } : {}),
  };
}

export function safeProducerPacketProjection(packet) {
  if (!packet) return undefined;
  return {
    schema_version: PRODUCER_PACKET_SCHEMA,
    workflow: PRODUCER_WORKFLOW,
    status: packet.status,
    packet_id: packet.packet_id,
    created_at: packet.created_at,
    bundle: packet.bundle,
    executive_summary: safeStatement(packet.executive_summary),
    source_inventory: packet.source_inventory.map(safeSource),
    version_provenance: packet.version_provenance,
    reconciliation: packet.reconciliation,
    production_decisions: packet.production_decisions.map(safeStatement),
    decision_register: packet.decision_register.map(safeRegisterEntry),
    locations_and_timing: packet.locations_and_timing.map(safeStatement),
    cast_role_demands: packet.cast_role_demands.map(safeStatement),
    department_requirements: packet.department_requirements.map(safeStatement),
    risks_or_conflicts: packet.risks_or_conflicts.map(safeStatement),
    cross_document_conflicts: packet.cross_document_conflicts.map(safeStatement),
    gaps_or_questions: packet.gaps_or_questions.map(safeStatement),
    handoff: packet.handoff,
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
