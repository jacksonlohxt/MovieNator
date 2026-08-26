# Phase 5 deployment and safety runbook

This repository contains a reproducible container shape and a Cloud Run manifest template. It does not select a Google project, billing account, region, model, service account, secret value, IAM policy, or paid resource. The commands marked **Operator action** are examples for an authorized operator and are not run by the application or test suite.

## Local modes

The server has three explicit runtime modes:

- `mock`: the default offline mode. It uses `FakeModel`, `MockProvider`, and synthetic `Demo evidence`.
- `adc_local`: an explicitly enabled server-only Gemini path using Application Default Credentials. It requires complete server configuration and `GOOGLE_AUTH_MODE=adc`.
- `deployed_identity`: a Cloud Run path using an attached workload identity. It requires `DEPLOYMENT_TARGET=cloud_run`, `RUNTIME_MODE=deployed_identity`, `GOOGLE_AUTH_MODE=workload_identity` or `attached_identity`, and complete server configuration.

A partial live configuration in a declared production or Cloud Run target fails closed at startup. It cannot silently turn into a mock result. An incomplete local Google hint remains disabled and is reported as `not_set`; it never makes a Google request. Safety settings, provider, endpoint, policy, and model identity are server-owned and are not accepted from browser fields or model output.

Both live modes require an actual **passed** Google readiness state, not merely the `GOOGLE_GEMINI_READINESS` env var (which is informational only and never read as authority by `src/gemini-rest.js`). `startServer` in `src/server.js` proves this itself: when Google is enabled and fully configured, it runs one real, awaited readiness preflight before the process accepts traffic, and keeps that evidence fresh with a bounded periodic recheck so it does not silently go stale after the 5-minute readiness window. If that boot-time preflight fails for a declared `adc_local` or `deployed_identity` `RUNTIME_MODE`, the process exits instead of serving mock traffic under a live-looking configuration. See [`docs/operator-runbook.md`](operator-runbook.md) for the exact steps and the `npm run google:preflight` command an operator runs first to check credentials and configuration before starting the server.

```sh
npm ci
npm test
npm run check
npm start
npm run smoke:deployment
```

The local server listens on `127.0.0.1:4173`. `PORT` is bounded to 1024-65535. For a local ADC-backed run, use an ignored `.env.local` with placeholders replaced only on the operator machine:

```sh
RUNTIME_MODE=adc_local
DEPLOYMENT_TARGET=local
MODEL_BACKEND=google_rest
GOOGLE_GEMINI_ENABLED=true
GOOGLE_GEMINI_READINESS=passed
GOOGLE_PROJECT_ID=<OPERATOR_SELECTED_PROJECT_ID>
GOOGLE_LOCATION=<OPERATOR_SELECTED_REGION>
GOOGLE_MODEL_ID=<OPERATOR_SELECTED_MODEL_ID>
GOOGLE_AUTH_MODE=adc
```

**Operator action:** an authorized operator may run `gcloud auth application-default login` to establish local ADC. The worker does not run it, inspect the credential file, or add it to the repository.

## Container contract

`Dockerfile` uses `node:20-bookworm-slim`, installs production dependencies from `package-lock.json`, copies only runtime files, creates `/data`, and runs as the unprivileged `node` user. The image defaults to explicit mock mode so it is usable without credentials. `PORT=8080` and `DATA_PATH=/data/runs.json` are container defaults. `.dockerignore` excludes `.env*`, ADC files, local data, logs, tests, and git metadata.

```sh
docker build --pull -t movieinator:<OPERATOR_SELECTED_TAG> .
docker run --rm -p 8080:8080 movieinator:<OPERATOR_SELECTED_TAG>
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke:deployment
```

The image build and local container run do not create cloud resources. The smoke command checks only `/healthz` and `/readyz` and refuses credential-shaped fields in those responses. It does not submit a model request.

The server sets bounded request, header, keep-alive, model call, request-size, output, token, rate, and run deadline budgets. `/healthz` is liveness only. `/readyz` reports a safe mode/configuration state and returns a non-2xx response when a live mode has not passed readiness. SIGTERM stops new work and gives existing connections a bounded graceful-shutdown window.

## Cloud Run shape

`deploy/cloud-run.yaml` is a structurally real, valid `serving.knative.dev/v1` Service manifest with no real project, account, secret, or credential; every value an operator must supply is an explicit `<OPERATOR_SELECTED_...>` placeholder. It declares port 8080, bounded concurrency and timeout, a cost-bounding `autoscaling.knative.dev/maxScale` annotation, a non-default runtime service account placeholder, explicit `deployed_identity` and optional `managed_interactions` modes, an operator-selected managed agent ID placeholder, 100% traffic to the latest revision, and no secret value. The `MOVIEINATOR_SECRET_REF` value is a resource-name placeholder, not a credential. The previous `MOVIE_INATOR_SECRET_REF` name remains accepted as a compatibility alias. `test/phase5.test.js` checks the manifest's structural shape, its declared env vars, and that it contains no secret-shaped literal. Managed mode, and the `deployed_identity` REST mode, still fail closed until the server's own awaited, active Google readiness preflight passes at boot; see [`docs/operator-runbook.md`](operator-runbook.md) for the exact operator steps and the `npm run google:preflight` command that proves this before deploying.

**Operator action - resource creation or update:** after choosing a project, billing account, region, artifact repository, service name, runtime service account, model, quota, and policy, an authorized operator may build and publish an image and apply the manifest. These commands can create or change paid resources and are intentionally not run here:

```sh
export PROJECT_ID='<OPERATOR_SELECTED_PROJECT_ID>'
export REGION='<OPERATOR_SELECTED_REGION>'
export IMAGE='<OPERATOR_SELECTED_ARTIFACT_IMAGE>'

# Operator action: inspect only.
gcloud projects describe "$PROJECT_ID"
gcloud run services describe <OPERATOR_SELECTED_CLOUD_RUN_SERVICE> --region="$REGION" --project="$PROJECT_ID"

# Operator action: image build/publish and Cloud Run service creation or update.
gcloud builds submit --project="$PROJECT_ID" --tag="$IMAGE" .
gcloud run services replace deploy/cloud-run.yaml --region="$REGION" --project="$PROJECT_ID"
```

Before applying the manifest, the operator must replace every `<OPERATOR_SELECTED_...>` placeholder and perform an independent readiness/contract check. Do not set readiness to `passed` without that check. Do not use service-account JSON keys. Use the attached service account or approved workload federation and grant only the minimum runtime permissions.

**Operator action - IAM change:** granting the Cloud Run runtime service account access to Vertex AI, Secret Manager, Artifact Registry, or invocation is an IAM mutation. Review and apply it separately; this repository does not contain an IAM policy and the worker does not run such commands.

After a service exists, the operator can run the read-only smoke check against its URL:

```sh
SMOKE_BASE_URL='https://<OPERATOR_SELECTED_CLOUD_RUN_HOST>' npm run smoke:deployment
```

The smoke URL is an operator-provided target. The worker does not discover or select a target.

## Secret Manager seam

Application code accepts only named Secret Manager references such as:

```text
projects/<OPERATOR_SELECTED_PROJECT_NUMBER>/secrets/<OPERATOR_SELECTED_SECRET_NAME>/versions/latest
```

`src/secrets.js` provides `SecretProvider`, `SecretManagerProvider`, `MockSecretProvider`, and `NullSecretProvider`. The provider is injected, reads a reference at runtime, and keeps values out of events, projections, files, and logs. Tests can use `MockSecretProvider` with in-memory values. No secret value, token, ADC file, or private project data belongs in this repository.

**Operator action - secret creation or update:** an authorized operator owns secret creation, rotation, version enablement, and Secret Manager IAM. The worker must not run these commands:

```sh
gcloud secrets create <OPERATOR_SELECTED_SECRET_NAME> --project="$PROJECT_ID" --replication-policy=user-managed --locations="$REGION"
gcloud secrets versions add <OPERATOR_SELECTED_SECRET_NAME> --data-file=<OPERATOR_CONTROLLED_INPUT>
```

Do not put secret values in shell history, manifests, fixtures, test snapshots, or deployment logs. Prefer workload identity and short-lived access.

## Gemini safety and audit boundary

`src/safety.js` is the single server-owned safety policy for text and future multimodal adapters. It fixes harm thresholds, input/output character limits, multimodal part and byte limits, request bytes, model calls, repair calls, deadlines, and per-key rate limits. It also provides deterministic redaction, safe error projections, and a bounded rate limiter. `src/gemini-rest.js` sends these fixed safety settings and validates model output against the approved schemas.

Audit records use `audit-event@1` and contain only configuration state, request outcome, model/provider provenance, safety blocks, and operator failure classes. Prompt text, provider responses, credentials, hidden reasoning, raw source, and secret values are omitted or replaced with bounded markers. The local store retains only bounded audit events for local inspection. Public API events remain safe projections.

## Google managed-agent and Interactions API path

Cloud Run is the current hosting shape for this server. The smallest future managed-agent adapter is the Node `@google/genai` package calling one operator-selected managed Agent Platform agent through `client.interactions.create`. The credential-free boundary, exact package pin, request shape, readiness gate, and safe event projection are documented in `docs/google-agent-runtime.md` and implemented in `src/producer-agent-boundary.js`.

The future path must preserve the same contracts:

1. Agent Builder or managed-agent configuration is an operator-controlled design and deployment surface, not a permission to expose arbitrary tools or model-selected providers.
2. The managed agent receives one bounded packet reference through the fixed `producer_packet.read / inspect_packet` contract. The adapter sends no dynamic tools, MCP URLs, arbitrary URLs, raw source, or credentials.
3. Cloud Run remains the API and browser facade. The managed agent must not bypass application-owned state, Policy Gate, Verifier, safe projections, or operator approval boundaries.
4. Project, agent ID, model, global location, identity, retention, quotas, and IAM remain operator-selected. Secret values remain in Secret Manager and are referenced by name only.
5. Managed-agent rollout requires contract tests, synthetic fixtures, evaluation results, passed readiness evidence, rollback, and an explicit cost/quota review.

**Operator action - future Agent Platform resource or IAM change:** any managed-agent creation, Agent Runtime deployment, API enablement, service account binding, networking, quota, or billing change is owned by an authorized operator. No command is supplied as an automatic worker step, and no live Agent Platform deployment is performed by this repository.
