const express = require("express");
const { hostname } = require("node:os");
const {
  BINANCE_UI_NAMESPACES,
  fetchBinanceNamespace,
} = require("./binance");

const BINANCE_PROBE_POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENCY = 6;
const POST_TIMEOUT_MS = 10_000;

function probeConfig(environment = process.env) {
  const primaryUrl = String(
    environment.PRIMARY_URL ||
      environment.WEBPAGE_TRACKER_PUBLIC_URL ||
      "https://webtracker.up.railway.app"
  )
    .trim()
    .replace(/\/+$/, "");
  const secret = String(environment.BINANCE_PROBE_SECRET || "").trim();
  const probeId = String(
    environment.PROBE_ID ||
      environment.RAILWAY_SERVICE_NAME ||
      environment.RAILWAY_REPLICA_ID ||
      hostname()
  ).trim();
  if (!secret) {
    throw new Error("Probe mode requires BINANCE_PROBE_SECRET");
  }
  return { primaryUrl, secret, probeId };
}

async function postObservation(observation, config, fetchImpl = global.fetch) {
  const response = await fetchImpl(
    `${config.primaryUrl}/internal/binance/observations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(observation),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    throw new Error(`Primary returned ${response.status}`);
  }
}

async function scanProbeNamespace(
  namespace,
  acknowledgedEtags,
  config,
  post = postObservation
) {
  const startedAt = Date.now();
  const etag = acknowledgedEtags.get(namespace) || null;
  const result = await fetchBinanceNamespace(namespace, etag);
  if (result.unchanged) return false;

  await post(
    {
      namespace,
      etag: result.etag,
      versionId: result.versionId,
      lastModified: result.lastModified,
      snapshot: result.data,
      probeId: config.probeId,
      observedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - startedAt,
    },
    config
  );
  acknowledgedEtags.set(namespace, result.etag);
  return true;
}

function createProbeScanner(config = probeConfig()) {
  const acknowledgedEtags = new Map();
  let scanning = false;

  async function scan() {
    if (scanning) return;
    scanning = true;
    let nextIndex = 0;
    try {
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENCY, BINANCE_UI_NAMESPACES.length) },
        async () => {
          while (nextIndex < BINANCE_UI_NAMESPACES.length) {
            const namespace = BINANCE_UI_NAMESPACES[nextIndex++];
            try {
              await scanProbeNamespace(namespace, acknowledgedEtags, config);
            } catch (error) {
              console.error(`[binance-probe] ${namespace}:`, error.message);
            }
          }
        }
      );
      await Promise.all(workers);
    } finally {
      scanning = false;
    }
  }

  return { acknowledgedEtags, scan };
}

function startBinanceProbe() {
  const config = probeConfig();
  const scanner = createProbeScanner(config);
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.get("/health", (_request, response) => response.status(200).send("ok"));
  app.use((_request, response) => response.status(404).send("Not found"));
  app.listen(port, "0.0.0.0", () => {
    console.log(`Binance probe ${config.probeId} listening on port ${port}`);
    scanner.scan();
    const timer = setInterval(scanner.scan, BINANCE_PROBE_POLL_INTERVAL_MS);
    timer.unref();
  });
}

module.exports = {
  BINANCE_PROBE_POLL_INTERVAL_MS,
  createProbeScanner,
  postObservation,
  probeConfig,
  scanProbeNamespace,
  startBinanceProbe,
};
