import { isPlainObject } from "./contracts.js";
import { safeErrorProjection } from "./safety.js";

export const SECRET_REFERENCE_PATTERN = /^projects\/[a-z0-9][a-z0-9-]{0,61}\/secrets\/[a-zA-Z0-9_-]{1,255}\/versions\/(?:latest|[1-9][0-9]*)$/;
export const SECRET_MANAGER_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export class SecretReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretReferenceError";
    this.code = code;
  }
}

export function parseSecretReference(reference) {
  if (typeof reference !== "string" || !SECRET_REFERENCE_PATTERN.test(reference)) {
    throw new SecretReferenceError("INVALID_SECRET_REFERENCE", "A Secret Manager resource reference is required");
  }
  const match = reference.match(/^projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^/]+)$/);
  return Object.freeze({ resourceName: reference, projectId: match[1], secretId: match[2], version: match[3] });
}

export class SecretProvider {
  async read() {
    throw new Error("SecretProvider.read is not implemented");
  }

  async getSecret(reference, options) {
    return this.read(reference, options);
  }
}

/** In-memory provider for unit tests only. It never writes values to output. */
export class MockSecretProvider extends SecretProvider {
  constructor({ values = {} } = {}) {
    super();
    this.values = new Map(Object.entries(values));
    this.reads = [];
  }

  async read(reference) {
    const parsed = parseSecretReference(reference);
    this.reads.push(parsed.resourceName);
    if (!this.values.has(parsed.resourceName)) throw new SecretReferenceError("SECRET_NOT_FOUND", "The configured secret reference was not found");
    return this.values.get(parsed.resourceName);
  }

  async getSecret(reference) {
    return this.read(reference);
  }
}

export class NullSecretProvider extends SecretProvider {
  async read() {
    throw new SecretReferenceError("SECRET_NOT_CONFIGURED", "No secret provider is configured");
  }

  async getSecret(reference) {
    return this.read(reference);
  }
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 200;
}

function responseBody(response) {
  if (typeof response?.body === "string") {
    try {
      return JSON.parse(response.body);
    } catch {
      return {};
    }
  }
  return isPlainObject(response?.body) ? response.body : response || {};
}

async function defaultTransport({ url, headers, signal }) {
  const response = await fetch(url, { method: "GET", headers, signal });
  return { status: response.status, body: await response.text() };
}

async function defaultTokenProvider() {
  throw new SecretReferenceError("SECRET_AUTH_UNAVAILABLE", "Secret Manager authentication is not configured");
}

function tokenFor(value) {
  if (typeof value === "string") return value.trim();
  if (isPlainObject(value)) return String(value.token || value.access_token || "").trim();
  return "";
}

/**
 * Runtime Secret Manager seam. Only a resource name crosses this boundary;
 * values are returned to the caller and are never logged or persisted here.
 */
export class SecretManagerProvider extends SecretProvider {
  constructor({ transport = defaultTransport, tokenProvider = defaultTokenProvider, endpoint = "https://secretmanager.googleapis.com" } = {}) {
    super();
    this.transport = transport;
    this.tokenProvider = typeof tokenProvider === "function" ? tokenProvider : tokenProvider?.getToken?.bind(tokenProvider) || defaultTokenProvider;
    this.endpoint = endpoint;
    if (!/^https:\/\/secretmanager\.googleapis\.com$/.test(this.endpoint)) throw new SecretReferenceError("INVALID_SECRET_ENDPOINT", "Secret Manager endpoint must use the Google HTTPS origin");
  }

  async read(reference, { signal } = {}) {
    const parsed = parseSecretReference(reference);
    let token;
    try {
      token = tokenFor(await this.tokenProvider({ scope: SECRET_MANAGER_SCOPE, signal }));
    } catch {
      throw new SecretReferenceError("SECRET_AUTH_UNAVAILABLE", "Secret Manager authentication is unavailable");
    }
    if (!token) throw new SecretReferenceError("SECRET_AUTH_UNAVAILABLE", "Secret Manager authentication did not return a token");
    let response;
    try {
      response = await this.transport({
        method: "GET",
        url: `${this.endpoint}/v1/${parsed.resourceName}:access`,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal,
      });
    } catch {
      throw new SecretReferenceError("SECRET_READ_FAILED", "Secret Manager could not be reached");
    }
    if (responseStatus(response) < 200 || responseStatus(response) >= 300) {
      const projection = safeErrorProjection({ code: responseStatus(response) === 403 ? "auth_denied" : "model_request_failed", status: responseStatus(response) });
      throw new SecretReferenceError(responseStatus(response) === 403 ? "SECRET_ACCESS_DENIED" : "SECRET_READ_FAILED", projection.message);
    }
    const payload = responseBody(response)?.payload;
    if (!payload || typeof payload.data !== "string") throw new SecretReferenceError("SECRET_RESPONSE_INVALID", "Secret Manager returned an invalid secret response");
    try {
      return Buffer.from(payload.data, "base64").toString("utf8");
    } catch {
      throw new SecretReferenceError("SECRET_RESPONSE_INVALID", "Secret Manager returned an invalid secret payload");
    }
  }

  async getSecret(reference, options) {
    return this.read(reference, options);
  }
}

export function createSecretProvider({ env = process.env, provider, transport, tokenProvider, mockValues } = {}) {
  if (provider) return provider;
  if (env.SECRET_PROVIDER === "mock") return new MockSecretProvider({ values: mockValues });
  if (Object.keys(env).some((name) => /_SECRET_REF$/.test(name))) return new SecretManagerProvider({ transport, tokenProvider });
  return new NullSecretProvider();
}
