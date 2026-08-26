// Operator-run readiness preflight for the live Gemini REST call path.
//
// This script makes a real, credentialed request to Vertex AI when Google
// Gemini is explicitly enabled and fully configured. It is not part of
// `npm test`, `npm run check`, or `npm run check:docs`, all of which remain
// network-free. Run this yourself, with your own credentials, before you
// claim or rely on a live Gemini call path:
//
//   GOOGLE_GEMINI_ENABLED=true MODEL_BACKEND=google_rest \
//   GOOGLE_PROJECT_ID=<project> GOOGLE_LOCATION=<region> GOOGLE_MODEL_ID=<model> \
//   GOOGLE_AUTH_MODE=adc npm run google:preflight
//
// On Cloud Run or another environment with an attached identity, set
// GOOGLE_AUTH_MODE=workload_identity or attached_identity instead of adc;
// google-auth-library resolves Application Default Credentials or the
// attached identity automatically in both cases. The script prints one
// bounded JSON result and never prints a token, header, or raw provider
// payload. It exits 0 only when the live preflight actually passed.
import { createGeminiReadiness, readGeminiConfig } from "../src/gemini-rest.js";
import { createAdcTokenProvider } from "../src/google-auth.js";

function fail(reason, extra = {}) {
  console.error(JSON.stringify({ preflight: "failed", reason, ...extra }));
  process.exitCode = 1;
}

async function main() {
  const config = readGeminiConfig(process.env);
  if (!config.enabled) {
    fail("google_gemini_disabled", { hint: "Set GOOGLE_GEMINI_ENABLED=true to run a live preflight" });
    return;
  }
  if (!config.configured) {
    fail("incomplete_configuration", { missing: config.missing });
    return;
  }
  if (!["adc", "workload_identity", "attached_identity"].includes(config.authMode)) {
    fail("unsupported_auth_mode", { auth_mode: config.authMode, allowed: ["adc", "workload_identity", "attached_identity"] });
    return;
  }
  const readiness = createGeminiReadiness({ config, tokenProvider: createAdcTokenProvider() });
  const result = await readiness.check();
  const safe = {
    preflight: result.passed ? "passed" : "failed",
    state: result.state,
    checked_at: result.checked_at,
    error_code: result.evidence?.error_code || null,
    transport_status: result.evidence?.transport_status ?? null,
    project_id: config.projectId,
    location: config.location,
    model_id: config.modelId,
    auth_mode: config.authMode,
  };
  console.log(JSON.stringify(safe, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((error) => {
  fail("preflight_script_error", { code: error?.code || "unknown" });
});
