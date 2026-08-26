# MovieInator operator runbook: live Gemini and Cloud Run deployment

This is the exact, operator-only checklist to (a) enable one genuine live Gemini REST call and (b) deploy MovieInator to Cloud Run behind a public HTTPS URL. It performs no action itself. Every command below is something an authorized operator runs, with their own credentials, on their own machine or Cloud Shell. This repository, `npm test`, `npm run check`, and `npm run check:docs` remain network-free and make none of these calls.

Read first: [`docs/google-setup.md`](google-setup.md) for the required Captain/operator project choices, and [`docs/phase5-deployment.md`](phase5-deployment.md) for the wider container, runtime-mode, secret, and safety contract that this runbook assumes.

## Part A: enable one live Gemini REST call

1. **Choose exact values.** Project ID, billing account, region (`GOOGLE_LOCATION`), exact model ID (`GOOGLE_MODEL_ID`), and REST API version (`GOOGLE_REST_API_VERSION`). These are Captain/operator decisions, not code defaults.
2. **Enable the API and identity.**

   ```sh
   gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID"
   # Local development:
   gcloud auth application-default login
   # Cloud Run: grant the runtime service account Vertex AI access instead of using a local login.
   gcloud projects add-iam-policy-binding "$PROJECT_ID" \
     --member="serviceAccount:$RUNTIME_SERVICE_ACCOUNT" --role="roles/aiplatform.user"
   ```

3. **Set server configuration.** Local ADC example (`.env.local`, already git-ignored):

   ```sh
   RUNTIME_MODE=adc_local
   DEPLOYMENT_TARGET=local
   MODEL_BACKEND=google_rest
   GOOGLE_GEMINI_ENABLED=true
   GOOGLE_PROJECT_ID=<your project id>
   GOOGLE_LOCATION=<your region, e.g. us-central1 or global>
   GOOGLE_MODEL_ID=<your exact model id>
   GOOGLE_AUTH_MODE=adc
   ```

   On Cloud Run, the equivalent variables are already declared in [`deploy/cloud-run.yaml`](../deploy/cloud-run.yaml) with `GOOGLE_AUTH_MODE=workload_identity` and `RUNTIME_MODE=deployed_identity`; only the `<OPERATOR_SELECTED_...>` placeholders need real values.

4. **Prove the call path is genuinely live before relying on it.** Run the credential-checking preflight script yourself:

   ```sh
   npm run google:preflight
   ```

   This is the one command in this repository that makes a real network call, and only when `GOOGLE_GEMINI_ENABLED=true` and the configuration is complete; it is not part of `npm test` or `npm run check`. It prints one bounded JSON result and exits `0` only when the live `generateContent` preflight actually passed:

   ```json
   { "preflight": "passed", "state": "passed", "checked_at": "...", "project_id": "...", "location": "...", "model_id": "...", "auth_mode": "adc" }
   ```

   A non-zero exit and `"preflight": "failed"` means the project, API enablement, IAM binding, region, or model ID is wrong; fix that before starting the server in a live mode.

5. **Start the server.** `npm run start:google` (local ADC) or a Cloud Run deployment (Part B) then performs its own real, awaited readiness preflight at boot using the same call path, and keeps that evidence fresh with a bounded periodic recheck (implemented in `startServer` in `src/server.js`). A declared live `RUNTIME_MODE` (`adc_local` or `deployed_identity`) that cannot pass this boot-time check fails closed immediately (the process exits, or the Cloud Run revision fails to become ready) rather than silently serving mock traffic under a live-looking configuration.
6. **Confirm from the outside.**

   ```sh
   curl -s http://127.0.0.1:4173/readyz   # or the deployed URL from Part B
   ```

   Only claim a live Gemini call path when this returns `"ok": true`, `"mode": "google_rest"`, and `"google": {"state": "passed", "checked": true, "passed": true, "stale": false}`.

## Part B: deploy to Cloud Run and obtain a public HTTPS URL

1. **Choose the deployment inputs.** Project ID, billing account, region, Artifact Registry repository, Cloud Run service name, and a dedicated runtime service account (do not use the default compute service account).
2. **Create the runtime identity and grant least-privilege roles.**

   ```sh
   gcloud iam service-accounts create <service-account-id> --project="$PROJECT_ID"
   gcloud projects add-iam-policy-binding "$PROJECT_ID" \
     --member="serviceAccount:<service-account-id>@$PROJECT_ID.iam.gserviceaccount.com" --role="roles/aiplatform.user"
   # Only if deploy/cloud-run.yaml's MOVIEINATOR_SECRET_REF is used:
   gcloud secrets add-iam-policy-binding <secret-name> --project="$PROJECT_ID" \
     --member="serviceAccount:<service-account-id>@$PROJECT_ID.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
   ```

3. **Build and push the image.**

   ```sh
   export PROJECT_ID='<your project id>'
   export REGION='<your region>'
   export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/<repository>/movieinator:<tag>"
   gcloud builds submit --project="$PROJECT_ID" --tag="$IMAGE" .
   ```

4. **Fill in the manifest and deploy.** Copy [`deploy/cloud-run.yaml`](../deploy/cloud-run.yaml), replace every `<OPERATOR_SELECTED_...>` placeholder with the real project, region, image, service account, model ID, managed agent ID (if used), and secret reference, then:

   ```sh
   gcloud run services replace deploy/cloud-run.yaml --region="$REGION" --project="$PROJECT_ID"
   ```

5. **Decide public access.** Cloud Run services are private by default. To expose the public HTTPS URL the contest requires:

   ```sh
   gcloud run services add-iam-policy-binding <service-name> --region="$REGION" --project="$PROJECT_ID" \
     --member="allUsers" --role="roles/run.invoker"
   ```

6. **Get the URL.**

   ```sh
   gcloud run services describe <service-name> --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)'
   ```

7. **Prove live before claiming it.** Run both checks against the returned URL:

   ```sh
   SMOKE_BASE_URL='https://<your-service>-<hash>.<region>.run.app' npm run smoke:deployment
   curl -s 'https://<your-service>-<hash>.<region>.run.app/readyz'
   ```

   `smoke:deployment` checks `/healthz` and `/readyz` and refuses any response containing a credential-shaped field. The `/readyz` body is the authoritative live-status evidence: only `"ok": true` with `"google": {"state": "passed", "checked": true, "passed": true, "stale": false}` supports a claim of a genuinely live, deployed Gemini call path. `"mode": "mock-only"` or a stale/failed `google` block means the deployment is still mock or not yet live, whatever the manifest's env values say.

## Part C: enable Parallel Search external evidence enrichment

This is a separate, optional, credential-gated feature (see [`docs/parallel-search-enrichment.md`](parallel-search-enrichment.md) for the full contract); it never affects Gemini configuration and is off by default.

1. **Obtain an API key.** Create an account at [platform.parallel.ai](https://platform.parallel.ai) and generate an API key from the dashboard.
2. **Set it as server configuration only.** Never commit this value.

   ```sh
   # .env.local (already git-ignored), or your deployment's own secret store
   PARALLEL_API_KEY=<your Parallel API key>
   ```

3. **Start the server as usual** (`npm run start:google` reads `.env.local`, or export the variable directly before `npm start`). `src/parallel-search.js` reports `enabled: true` only when this variable is present, and every producer packet's `provenance.external_evidence_enabled` reflects the same fact. No repository test, `npm run check`, or `npm run check:docs` ever sets this variable, so the regression gate always exercises the off/deterministic path plus an injected-mock on path in `test/parallel-search.test.js`.
4. **Confirm from the outside.** Build a Producer Intake Decision Packet whose bundle establishes a scene location or a budget input; its `external_evidence` array and citations (`source_kind: "external_research"`) should be non-empty and cite real Parallel result URLs.

## Honesty and fail-closed notes

- `GOOGLE_GEMINI_READINESS=passed` in the manifest or an env file is informational only; `src/gemini-rest.js` never reads it as authority. Only an actual, passed, unstale `GeminiReadiness.check()` result makes the server report or use a live call path.
- Readiness evidence goes stale after 5 minutes (`GEMINI_READINESS_MAX_AGE_MS`); the server's periodic recheck keeps it fresh automatically, but if Vertex AI, the project, or the identity becomes unavailable, `/readyz` and the live call path correctly go unready rather than continuing to claim success.
- Never commit an ADC file, service-account JSON key, bearer token, or secret value. Cloud Run should use the attached workload identity (`GOOGLE_AUTH_MODE=workload_identity`), and `MOVIEINATOR_SECRET_REF` must remain a Secret Manager resource-name reference, never a secret value.
- A partial or failed live configuration in a declared production or Cloud Run target fails closed at startup by design; do not work around this by silently falling back to `RUNTIME_MODE=mock` in a deployment meant to demonstrate live Google Cloud use.
