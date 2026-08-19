import { hashValue } from "./contracts.js";
import { redactForAudit } from "./safety.js";

export const AUDIT_SCHEMA = "audit-event@1";
export const AUDIT_EVENT_TYPES = Object.freeze([
  "configuration_state",
  "request_outcome",
  "model_provenance",
  "provider_provenance",
  "safety_block",
  "operator_failure",
]);

function safeCode(value) {
  return typeof value === "string" ? value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 100) : undefined;
}

function safeId(value) {
  return typeof value === "string" ? value.slice(0, 160) : undefined;
}

export function createAuditEvent({
  type,
  outcome = "recorded",
  mode = "unknown",
  runId,
  code,
  provenance,
  attributes = {},
  clock = Date,
} = {}) {
  if (!AUDIT_EVENT_TYPES.includes(type)) throw new Error("Unknown audit event type");
  const event = {
    schema_version: AUDIT_SCHEMA,
    event_id: `audit_${hashValue(`${type}|${mode}|${runId || ""}|${code || ""}|${new clock().toISOString()}`).slice(0, 32)}`,
    type,
    outcome: safeCode(outcome) || "recorded",
    mode: safeCode(mode) || "unknown",
    occurred_at: new clock().toISOString(),
    ...(runId ? { run_id: safeId(runId) } : {}),
    ...(code ? { code: safeCode(code) } : {}),
    ...(provenance ? { provenance: redactForAudit(provenance, { maxStringLength: 180 }) } : {}),
    attributes: redactForAudit(attributes, { maxStringLength: 180 }),
  };
  return Object.freeze(event);
}

export class AuditRecorder {
  constructor({ sink = () => {}, clock = Date } = {}) {
    this.sink = sink;
    this.clock = clock;
    this.events = [];
  }

  record(input) {
    const event = createAuditEvent({ ...input, clock: this.clock });
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    this.sink(event);
    return event;
  }
}

export function createAuditRecorder({ store, logger, clock = Date } = {}) {
  return new AuditRecorder({
    clock,
    sink: (event) => {
      if (store && typeof store.appendAuditEvent === "function") store.appendAuditEvent(event);
      if (typeof logger === "function") logger(event);
    },
  });
}
