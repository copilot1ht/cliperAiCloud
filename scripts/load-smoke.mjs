const target = String(process.env.LOAD_TEST_URL || "http://127.0.0.1:4100/health/live").trim();
const durationSeconds = Math.max(1, Math.min(120, Number(process.env.LOAD_TEST_DURATION_SECONDS || 15)));
const concurrency = Math.max(1, Math.min(100, Math.floor(Number(process.env.LOAD_TEST_CONCURRENCY || 20))));

if (/cliperaicloud\.online/i.test(target) && process.env.ALLOW_PRODUCTION_LOAD_TEST !== "true") {
  throw new Error("Refusing to load test production. Use a staging URL, or set ALLOW_PRODUCTION_LOAD_TEST=true after an approved capacity window.");
}

const deadline = Date.now() + durationSeconds * 1_000;
const measurements = [];
let completed = 0;
let failed = 0;

async function worker() {
  while (Date.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(target, { headers: { "x-load-test": "cliper-local-smoke" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      measurements.push(performance.now() - startedAt);
      completed += 1;
    } catch {
      failed += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
measurements.sort((left, right) => left - right);
const percentile = (value) => measurements.length ? Math.round(measurements[Math.min(measurements.length - 1, Math.floor(measurements.length * value))] || 0) : 0;
const total = completed + failed;
const report = {
  target,
  durationSeconds,
  concurrency,
  requests: total,
  success: completed,
  failed,
  requestsPerSecond: Number((total / durationSeconds).toFixed(2)),
  errorRatePercent: total ? Number((failed / total * 100).toFixed(2)) : 100,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
};
console.log(JSON.stringify(report));
if (!completed || report.errorRatePercent > 1) process.exitCode = 1;
