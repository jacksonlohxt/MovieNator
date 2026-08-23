# Phase 5 deployment and safety runbook

This repository contains a reproducible container shape and a Cloud Run manifest template. It does not select a Google project, billing account, region, model, service account, secret value, IAM policy, or paid resource. The commands marked **Operator action** are examples for an authorized operator and are not run by the application or test suite.

## Local modes

The server has three explicit runtime modes:

- `mock`: the default offline mode. It uses `FakeModel`, `MockProvider`, and synthetic `Demo evidence`.
- `adc_local`: an explicitly enabled server-only Gemini path using Application Default Credentials. It requires complete server configuration, `GOOGLE_AUTH_MODE=adc`, and `GOOGLE_GEMINI_READINESS=passed`.
- `deployed_identity`: a future Cloud Run path using an attached workload identity. It requires `DEPLOYMENT_TARGET=cloud_run`, `RUNTIME_MODE=deployed_identity`, `GOOGLE_AUTH_MODE=workload_identity` or `attached_identity`, complete server configuration, and passed operator readiness.

A partial live configuration in a declared production or Cloud Run target fails closed at startup. It cannot silently turn into a mock result. An incomplete local Google hint remains disabled and is reported as `not_set`; it never makes a Google request. Safety settings, provider, endpoint, policy, and model identity are server-owned and are not accepted from browser fields or model output.

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
docker build --pull -t movie-inator:<OPERATOR_SELECTED_TAG> .
docker run --rm -p 8080:8080 movie-inator:<OPERATOR_SELECTED_TAG>
SMOKE_BASE_URL=http://127.0.0.1:8080 npm run smoke:deployment
```

The image build and local container run do not create cloud resources. The smoke command checks only `/healthz` and `/readyz` and refuses credential-shaped fields in those responses. It does not submit a model request.

The server sets bounded request, header, keep-alive, model call, request-size, output, token, rate, and run deadline budgets. `/healthz` is liveness only. `/readyz` reports a safe mode/configuration state and returns a non-2xx response when a live mode has not passed readiness. SIGTERM stops new work and gives existing connections a bounded graceful-shutdown window.

## Cloud Run shape

`deploy/cloud-run.yaml` is a placeholder-only manifest. It declares port 8080, bounded concurrency and timeout, a non-default runtime service account placeholder, explicit `deployed_identity` mode, and no secret value. The `MOVIE_INATOR_SECRET_REF` value is a resource-name placeholder, not a credential.

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

### Hosting readiness gate

The manifest, Dockerfile, and smoke script are not a hosted deployment and do not prove a public URL. Before advertising a hosted Movie-Inator, the operator must verify HTTPS, access control for screenplay uploads, request/body/rate/cost limits, health and readiness behavior, bounded logs and alerts, storage and deletion policy, residency, backups, persistent state appropriate to the selected scale, Secret Manager access, rollback, accessibility, and cost/quota posture. `FileStore` and `.data` prove local mock behavior only and are not a durable multi-instance public database. Record the final URL, runtime mode, model/partner status, smoke result, owner, and retention decision separately.

No hosted Movie-Inator URL, public service, persistent production store, or live runtime is proven by this repository.

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

## Later Agent Builder and Agent Runtime path

Cloud Run is the current hosting shape for this server. A later managed orchestration path may package the bounded Movie-Inator workflow for Agent Builder and deploy the agent to **Agent Runtime**. Google documentation now uses Agent Runtime for the managed runtime previously referred to as Agent Engine. This is a future operator decision, not an enabled repository integration.

The later path must preserve the same contracts:

1. Agent Builder is a design, grounding, evaluation, and configuration surface, not a permission to expose arbitrary tools or model-selected providers.
2. Agent Runtime receives one versioned workflow package, fixed semantic operations, server-owned safety settings, an attached identity, bounded deadlines, and a redacted event sink.
3. Cloud Run remains a possible API and browser facade. Agent Runtime must not bypass the existing Policy Gate, Verifier, safe projections, or operator approval boundary.
4. Grounding sources, model IDs, region, retention, quotas, and IAM remain operator-selected. Secret values remain in Secret Manager and are referenced by name only.
5. Agent Builder/Agent Runtime rollout requires contract tests, synthetic fixtures, evaluation results, readiness evidence, rollback, and an explicit cost/quota review.

**Operator action - future Agent Builder/Agent Runtime resource or IAM change:** any Agent Builder configuration, Agent Runtime deployment, API enablement, service account binding, networking, quota, or billing change is owned by an authorized operator. No command is supplied as an automatic worker step, and no live Agent Runtime deployment is performed by this repository.
