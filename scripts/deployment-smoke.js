const base = (process.argv[2] || process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4173}`).replace(/\/$/, "");

async function check(pathname) {
  const response = await fetch(`${base}${pathname}`, { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return body;
}

try {
  const health = await check("/healthz");
  const readiness = await check("/readyz");
  if (health.ok !== true || readiness.ok !== true) throw new Error("health or readiness did not report ok");
  const forbidden = JSON.stringify({ health, readiness });
  if (/bearer|secret|password|private[_ -]?key|api[_ -]?key/i.test(forbidden)) throw new Error("health response contained a credential-shaped field");
  console.log(JSON.stringify({ smoke: "passed", base, mode: readiness.runtime_mode || readiness.mode, model_backend: readiness.model_backend }));
} catch (error) {
  console.error(JSON.stringify({ smoke: "failed", base, code: "deployment_smoke_failed" }));
  process.exitCode = 1;
}
