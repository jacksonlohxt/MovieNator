import { TextDecoder } from "node:util";
import { inflateSync } from "node:zlib";
import { ContractError, hashValue, redactText, stableStringify } from "./contracts.js";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.js";

export const DOCUMENT_SCHEMA = "grounding-document@1";
export const GROUNDING_REQUEST_SCHEMA = "grounded-brief-request@1";
export const SCRIPT_BRIEF_REQUEST_SCHEMA = "grounded-brief-request@2";
export const DEFAULT_SCRIPT_BRIEF_REQUEST = "Create a concise filmmaker-facing brief with the story essentials, key characters, setting, tone, themes, useful production details, and any open questions or gaps.";
export const DOCUMENT_MEDIA_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".txt": "text/plain",
});
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_FILENAME_CHARS = 120;
export const MAX_EXTRACTED_CHARS = 120_000;
export const MAX_PDF_STREAM_OUTPUT_BYTES = MAX_EXTRACTED_CHARS;
export const MAX_CHUNK_CHARS = 900;
export const MAX_DOCUMENT_CHUNKS = 240;
// A brief is condensed from the whole bounded source, not just a handful of
// keyword hits. These limits keep the prompt, citations, and response bounded.
export const MAX_SELECTED_EXCERPTS = 24;
export const MAX_SELECTED_CHARS = 18_000;
export const MAX_WHOLE_DOCUMENT_EXCERPTS = 24;
export const MAX_WHOLE_DOCUMENT_CHARS = 18_000;

export class DocumentContractError extends ContractError {
  constructor(code, message, field = undefined) {
    super(code, message, field);
    this.name = "DocumentContractError";
  }
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function normalizeDocumentText(value) {
  return value
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<\/?[a-z][^>]*>|(?:https?|ftp):\/\/\S+|www\.\S+/gi, "[redacted]")
    .split("\n")
    .map((line) => redactText(line.trimEnd(), 4_000))
    .join("\n")
    .trim();
}

function safeFilename(value) {
  const original = asText(value).normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) || "";
  const sanitized = original
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, MAX_FILENAME_CHARS);
  if (!sanitized || sanitized === "." || sanitized === "..") throw new DocumentContractError("INVALID_FILENAME", "A safe filename is required", "filename");
  return sanitized;
}

function extensionFor(filename) {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return DOCUMENT_MEDIA_TYPES[extension] ? extension : undefined;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentContractError("INVALID_ENCODING", "Plain-text sources must be valid UTF-8", "file");
  }
}

function decodePdfLiteral(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const next = value[++index];
    if (next === undefined) break;
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    if (escapes[next]) {
      result += escapes[next];
    } else if (/[0-7]/.test(next)) {
      const octal = `${next}${value[index + 1] || ""}${value[index + 2] || ""}`.match(/^[0-7]{1,3}/)?.[0] || next;
      index += octal.length - 1;
      result += String.fromCharCode(parseInt(octal, 8));
    } else {
      result += next;
    }
  }
  return result;
}

function decodePdfHex(value) {
  const compact = value.replace(/\s/g, "");
  if (!/^[0-9a-f]*$/i.test(compact)) return "";
  const padded = compact.length % 2 ? `${compact}0` : compact;
  const bytes = Buffer.from(padded, "hex");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractPdfOperators(value) {
  const text = value.toString("latin1");
  const strings = [];
  for (const match of text.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) strings.push(decodePdfLiteral(match[1]));
  for (const match of text.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
    for (const literal of match[1].matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9a-f\s]+)>/gi)) {
      strings.push(literal[1] !== undefined ? decodePdfLiteral(literal[1]) : decodePdfHex(literal[2]));
    }
  }
  for (const match of text.matchAll(/<([0-9a-f\s]+)>\s*Tj/gi)) strings.push(decodePdfHex(match[1]));
  return strings.map((item) => normalizeDocumentText(item)).filter(Boolean);
}

function decodePdfStream(object) {
  const streamStart = object.indexOf("stream");
  if (streamStart < 0) return Buffer.from(object, "latin1");
  let start = streamStart + 6;
  if (object[start] === "\r") start += object[start + 1] === "\n" ? 2 : 1;
  else if (object[start] === "\n") start += 1;
  const end = object.lastIndexOf("endstream");
  if (end < start) throw new DocumentContractError("INVALID_PDF", "The PDF contains an unreadable text stream", "file");
  let stream = Buffer.from(object.slice(start, end), "latin1");
  if (/\/FlateDecode(?:\s|\/|>|\])/.test(object.slice(0, streamStart))) {
    try {
      stream = inflateSync(stream, { maxOutputLength: MAX_PDF_STREAM_OUTPUT_BYTES });
    } catch {
      throw new DocumentContractError("INVALID_PDF", "The PDF contains an unreadable text stream", "file");
    }
  } else if (/\/ASCIIHexDecode(?:\s|\/|>|\])/.test(object.slice(0, streamStart))) {
    const hex = stream.toString("latin1").replace(/>[^]*$/, "").replace(/\s/g, "");
    if (!/^[0-9a-f]*$/i.test(hex)) throw new DocumentContractError("INVALID_PDF", "The PDF contains an unreadable text stream", "file");
    stream = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
  }
  return stream;
}

function parsePdf(bytes) {
  const header = bytes.subarray(0, 5).toString("latin1");
  if (header !== "%PDF-") throw new DocumentContractError("INVALID_PDF", "The uploaded file is not a PDF", "file");
  const text = bytes.toString("latin1");
  const objects = new Map();
  for (const match of text.matchAll(/(?:^|\n)\s*(\d+)\s+\d+\s+obj\s([\s\S]*?)\s*endobj/g)) objects.set(match[1], match[2]);
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page(?:\s|\/|>)/.test(object));
  const segments = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const contents = page.match(/\/Contents\s*(?:\[([\s\S]*?)\]|(\d+\s+\d+\s+R))/);
    const references = contents ? [...(contents[1] || contents[2]).matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => match[1]) : [];
    const contentObjects = references.map((reference) => objects.get(reference)).filter(Boolean);
    const streams = contentObjects.length ? contentObjects : [page];
    const pageText = streams.flatMap((object) => extractPdfOperators(decodePdfStream(object))).join("\n");
    if (pageText) segments.push({ text: pageText, location: { kind: "page", page: index + 1 } });
  }
  if (!segments.length) throw new DocumentContractError("PDF_NO_TEXT", "The PDF did not contain readable text", "file");
  return segments;
}

function looksLikeHeading(line) {
  const value = line.trim();
  if (!value || value.length > 120) return false;
  if (/^#+\s+/.test(value) || /^section\s*[:\-]/i.test(value) || /^(?:int|ext|i\/e)\.?\s+/i.test(value)) return true;
  return /^[A-Z][A-Z0-9 &'()./-]{3,}:?$/.test(value) && !/[.!?]$/.test(value);
}

function headingName(line) {
  return line.trim().replace(/^#+\s*/, "").replace(/^section\s*[:\-]\s*/i, "").slice(0, 120) || "Document";
}

function parsePlainText(text) {
  const lines = text.split("\n");
  const segments = [];
  let section = "Document";
  let block = [];
  let blockStart = 1;
  const flush = (endLine) => {
    if (!block.length) return;
    segments.push({
      text: block.join("\n"),
      location: { kind: "section", section, line_start: blockStart, line_end: endLine },
    });
    block = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      flush(index);
      continue;
    }
    if (looksLikeHeading(line)) {
      flush(index);
      section = headingName(line);
      blockStart = index + 2;
      continue;
    }
    if (!block.length) blockStart = index + 1;
    block.push(line);
  }
  flush(lines.length);
  return segments;
}

function boundedSegments(segments) {
  const result = [];
  let remaining = MAX_EXTRACTED_CHARS;
  for (const segment of segments) {
    const normalized = normalizeDocumentText(segment.text);
    if (!normalized || remaining <= 0) continue;
    const bounded = normalized.slice(0, remaining);
    result.push({ text: bounded, location: segment.location });
    remaining -= bounded.length;
  }
  if (!result.length) throw new DocumentContractError("EMPTY_DOCUMENT", "The source did not contain readable text", "file");
  return { segments: result, truncated: remaining === 0 && result.at(-1).text.length < normalizeDocumentText(segments.at(-1)?.text || "").length };
}

function splitForChunking(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let boundary = remaining.lastIndexOf(" ", maxChars);
    if (boundary < Math.floor(maxChars * 0.55)) boundary = maxChars;
    pieces.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

export function chunkSegments(documentId, segments, { maxChars = MAX_CHUNK_CHARS } = {}) {
  const chunks = [];
  for (const segment of segments) {
    for (const excerpt of splitForChunking(segment.text, maxChars)) {
      const ordinal = chunks.length;
      const chunkId = `chunk_${hashValue(stableStringify({ document_id: documentId, ordinal, excerpt, location: segment.location })).slice(0, 32)}`;
      chunks.push({ chunk_id: chunkId, ordinal, excerpt, source_locations: [segment.location] });
      if (chunks.length >= MAX_DOCUMENT_CHUNKS) return chunks;
    }
  }
  return chunks;
}

export function parseGroundingDocument({ filename, contentType, bytes }) {
  if (!Buffer.isBuffer(bytes)) throw new DocumentContractError("INVALID_FILE", "A binary file is required", "file");
  if (bytes.length < 1 || bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentContractError("DOCUMENT_TOO_LARGE", `Documents must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes`, "file");
  const safeName = safeFilename(filename);
  const extension = extensionFor(safeName);
  const mediaType = asText(contentType).split(";", 1)[0].trim().toLowerCase();
  if (!extension || DOCUMENT_MEDIA_TYPES[extension] !== mediaType) throw new DocumentContractError("UNSUPPORTED_DOCUMENT_TYPE", "Only matching PDF and plain-text uploads are accepted", "file");
  const rawSegments = mediaType === "application/pdf" ? parsePdf(bytes) : parsePlainText(decodeUtf8(bytes));
  const bounded = boundedSegments(rawSegments);
  const canonicalText = bounded.segments.map((segment) => segment.text).join("\n\n");
  const documentId = `doc_${hashValue(stableStringify({ media_type: mediaType, text: canonicalText }))}`;
  const chunks = chunkSegments(documentId, bounded.segments);
  return {
    schema_version: DOCUMENT_SCHEMA,
    document_id: documentId,
    filename: safeName,
    media_type: mediaType,
    byte_size: bytes.length,
    text_char_count: canonicalText.length,
    truncated: bounded.truncated,
    source_label: `${PRODUCT_DISPLAY_NAME} uploaded script source`,
    chunks,
    chunk_count: chunks.length,
    ingestion: { state: "ready", extracted_chars: canonicalText.length, chunk_count: chunks.length, truncated: bounded.truncated },
  };
}

export function validateGroundingRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentContractError("INVALID_REQUEST", "Grounded brief request must be an object");
  const version = value.schema_version;
  const isScriptBrief = version === SCRIPT_BRIEF_REQUEST_SCHEMA;
  const allowed = isScriptBrief ? new Set(["schema_version", "request", "question"]) : new Set(["schema_version", "question"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DocumentContractError("UNKNOWN_FIELD", `Grounded brief request contains unknown field: ${key}`, key);
  if (version !== GROUNDING_REQUEST_SCHEMA && !isScriptBrief) throw new DocumentContractError("INVALID_SCHEMA_VERSION", `schema_version must be ${GROUNDING_REQUEST_SCHEMA} or ${SCRIPT_BRIEF_REQUEST_SCHEMA}`, "schema_version");
  const supplied = isScriptBrief ? (value.request ?? value.question ?? DEFAULT_SCRIPT_BRIEF_REQUEST) : value.question;
  const question = asText(supplied).normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (question.length < 1 || question.length > 1_000) throw new DocumentContractError("INVALID_QUESTION", "request must be 1 to 1,000 characters", isScriptBrief ? "request" : "question");
  return isScriptBrief
    ? { schema_version: SCRIPT_BRIEF_REQUEST_SCHEMA, request: question, question, brief_version: 2 }
    : { schema_version: GROUNDING_REQUEST_SCHEMA, question };
}

export function safeDocumentProjection(document, { includeChunks = false } = {}) {
  if (!document) return undefined;
  return {
    schema_version: DOCUMENT_SCHEMA,
    document_id: document.document_id,
    filename: document.filename,
    media_type: document.media_type,
    byte_size: document.byte_size,
    text_char_count: document.text_char_count,
    truncated: Boolean(document.truncated),
    source_label: document.source_label,
    chunk_count: document.chunk_count,
    ingestion: document.ingestion,
    ...(includeChunks ? { chunks: document.chunks.map((chunk) => ({ chunk_id: chunk.chunk_id, ordinal: chunk.ordinal, source_locations: chunk.source_locations })) } : {}),
  };
}

export function citationForChunk(document, chunk) {
  return {
    citation_id: `cite_${hashValue(`${document.document_id}|${chunk.chunk_id}`).slice(0, 32)}`,
    document_id: document.document_id,
    chunk_id: chunk.chunk_id,
    source_locations: chunk.source_locations,
    excerpt: chunk.excerpt,
  };
}

export function safeCitationProjection(citation) {
  return {
    schema_version: "grounding-citation@1",
    citation_id: citation.citation_id,
    document_id: citation.document_id,
    chunk_id: citation.chunk_id,
    source_locations: citation.source_locations,
    excerpt: citation.excerpt.slice(0, MAX_CHUNK_CHARS),
    source_label: `${PRODUCT_DISPLAY_NAME} uploaded script source`,
  };
}
