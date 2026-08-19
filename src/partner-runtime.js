import {
  PartnerContractError,
  PartnerError,
  createPartnerEvent,
  isRetryablePartnerError,
  mapPartnerError,
  partnerReadiness,
  redactPartnerValue,
  safePartnerHash,
} from "./partner-contracts.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clockNow(clock) {
  try {
    return new clock();
  } catch {
    return new Date();
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PartnerCircuitBreaker {
  constructor({ clock = Date, failureThreshold = 3, cooldownMs = 30_000 } = {}) {
    this.clock = clock;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = null;
    this.halfOpen = false;
  }

  get state() {
    if (this.openedAt === null) return "closed";
    if (clockNow(this.clock).getTime() - this.openedAt >= this.cooldownMs) return "half_open";
    return "open";
  }

  beforeCall() {
    const state = this.state;
    if (state === "open") throw new PartnerError("circuit_open", "Partner circuit is open after repeated failures", { retryable: false, status: 503 });
    this.halfOpen = state === "half_open";
    return state;
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpen = false;
  }

  failure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold || this.halfOpen) this.openedAt = clockNow(this.clock).getTime();
    this.halfOpen = false;
  }

  projection() {
    return {
      state: this.state,
      failure_count: Math.min(this.failures, this.failureThreshold),
      failure_threshold: this.failureThreshold,
      opened_at: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      retry_after: this.state === "open" ? new Date(this.openedAt + this.cooldownMs).toISOString() : null,
    };
  }
}

function withTimeout(operation, timeoutMs, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PartnerError("timeout", "Partner operation exceeded its bounded timeout", { retryable: true, status: 504 }));
    }, timeoutMs);
  });
  const promise = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  });
}

/**
 * Bounded partner runtime. It owns timeout, retry, duplicate delivery, circuit
 * state, and redacted events. Provider output remains evidence input and never
 * has policy or action authority.
 */
export class PartnerOperationRunner {
  constructor({ registry, clock = Date, maxAttempts = 2, timeoutMs = 8_000, backoffMs = 10, circuit = {} } = {}) {
    if (!registry) throw new PartnerContractError("INVALID_REGISTRY", "PartnerOperationRunner requires a PartnerRegistry");
    this.registry = registry;
    this.clock = clock;
    this.maxAttempts = Math.max(1, Math.min(2, maxAttempts));
    this.timeoutMs = Math.max(1, Math.min(120_000, timeoutMs));
    this.backoffMs = Math.max(0, Math.min(2_000, backoffMs));
    this.circuits = new Map();
    this.deliveries = new Map();
    this.events = [];
    this.eventLimit = 500;
    this.circuitOptions = circuit;
  }

  circuitFor(providerId) {
    if (!this.circuits.has(providerId)) this.circuits.set(providerId, new PartnerCircuitBreaker({ clock: this.clock, ...this.circuitOptions }));
    return this.circuits.get(providerId);
  }

  readiness(providerId, options = {}) {
    const circuit = this.circuitFor(providerId);
    return this.registry.readiness(providerId, { ...options, circuit: circuit.projection() });
  }

  projections(options = {}) {
    return this.registry.projections(options).map((projection) => ({
      ...projection,
      readiness: this.readiness(projection.provider.provider_id, options),
    }));
  }

  eventsFor(providerId) {
    return clone(this.events.filter((event) => !providerId || event.provider_id === providerId));
  }

  async execute({ providerId, operation, input = {}, context = {}, deliveryId = undefined, timeoutMs = this.timeoutMs, maxAttempts = this.maxAttempts } = {}) {
    // The registry validation is deliberately the first operation. Unknown
    // providers, endpoints, tools, and semantic capabilities fail here.
    const registration = this.registry.assertOperation(providerId, operation, context);
    const circuit = this.circuitFor(providerId);
    const deliveryKey = deliveryId ? `${providerId}|${operation}|${deliveryId}` : undefined;
    if (deliveryKey && this.deliveries.has(deliveryKey)) return { ...clone(this.deliveries.get(deliveryKey)), duplicate_delivery: true };
    const boundedAttempts = Math.max(1, Math.min(2, maxAttempts));
    const boundedTimeout = Math.max(1, Math.min(120_000, timeoutMs));
    let lastError;
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
      attemptsUsed = attempt;
      try {
        circuit.beforeCall();
        this.record({ providerId, operation, attempt, deliveryId, eventType: "partner.operation.attempt", state: "started", payload: { timeout_ms: boundedTimeout } });
        const raw = await withTimeout(
          (signal) => registration.entry.adapter.invoke(operation, input, { ...context, delivery_id: deliveryId, signal, provider_id: providerId, endpoint_ref: registration.capability.endpoint_ref }),
          boundedTimeout,
          context.signal,
        );
        circuit.success();
        const result = {
          status: "complete",
          provider_id: providerId,
          operation,
          attempt,
          data: redactPartnerValue(raw) || {},
          response_hash: safePartnerHash(raw),
          provenance: {
            ...registration.capability.redacted_provenance,
            operation,
            response_hash: safePartnerHash(raw),
            redacted: true,
          },
        };
        this.record({ providerId, operation, attempt, deliveryId, eventType: "partner.operation.completed", state: "complete", payload: { response_hash: result.response_hash } });
        if (deliveryKey) this.deliveries.set(deliveryKey, clone(result));
        return result;
      } catch (error) {
        const mapped = mapPartnerError(error);
        lastError = mapped;
        const retryable = isRetryablePartnerError(mapped) && attempt < boundedAttempts;
        circuit.failure();
        this.record({ providerId, operation, attempt, deliveryId, eventType: "partner.operation.failed", state: retryable ? "retrying" : "failed", errorClass: mapped.kind, payload: { retryable, circuit: circuit.projection() } });
        if (!retryable) break;
        await wait(this.backoffMs * attempt);
      }
    }
    const safeFailure = safePartnerFallback(lastError, { providerId, operation, attempts: attemptsUsed, circuit: circuit.projection() });
    if (deliveryKey) this.deliveries.set(deliveryKey, clone(safeFailure));
    return safeFailure;
  }

  record({ providerId, operation, attempt, deliveryId, eventType, state, errorClass, payload }) {
    const event = createPartnerEvent({
      providerId,
      eventType,
      operation,
      attempt,
      deliveryId,
      state,
      errorClass,
      payload,
      occurredAt: clockNow(this.clock).toISOString(),
    });
    if (this.events.length >= this.eventLimit) this.events.shift();
    this.events.push(event);
    return event;
  }
}

export function safePartnerFallback(error, { providerId, operation, attempts = 0, circuit = undefined } = {}) {
  const mapped = mapPartnerError(error);
  return {
    status: "unavailable",
    provider_id: providerId || null,
    operation: operation || null,
    attempts: Math.max(0, Math.min(2, attempts)),
    error_class: mapped.kind || "unavailable",
    message: mapped.kind === "missing_auth" ? "Partner access is not configured." : mapped.kind === "circuit_open" ? "Partner access is temporarily paused." : "Partner evidence is unavailable; no provider fallback was used.",
    fallback: "manual_or_explicit_demo_run",
    provider_fallback_used: false,
    circuit: circuit || undefined,
    provenance: { provider_id: providerId || null, operation: operation || null, redacted: true },
  };
}

export function readinessWithStaleCheck(registry, providerId, { now = new Date(), maxAgeMs = 30_000 } = {}) {
  const readiness = registry.readiness(providerId, { maxAgeMs });
  if (readiness.state !== "ready" || !readiness.checked_at) return readiness;
  if (now.getTime() - Date.parse(readiness.checked_at) > maxAgeMs) {
    return partnerReadiness({ capability: registry.getCapability(providerId), state: "stale", checkedAt: readiness.checked_at, reasonCodes: ["READINESS_CHECK_STALE"] });
  }
  return readiness;
}
