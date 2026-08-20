const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { dataDirectory, statements } = require("./db");
const { normalizeCtName } = require("./ct");

const CERTSPOTTER_BINARY = "certspotter";
const CERTSPOTTER_HEALTH_INTERVAL = "5m";
const CERTSPOTTER_CANARY = ".test.certspotter.org";
const MAX_HOOK_BYTES = 20 * 1024 * 1024;
const MAX_RESTART_MS = 60_000;

let child = null;
let hookServer = null;
let hookToken = null;
let hookUrl = null;
let restartTimer = null;
let stableTimer = null;
let restartAttempt = 0;
let expectedStop = false;
let shuttingDown = false;
let activeWatchlist = "";
let callbacks = {};
let stoppingPromise = null;

const managerStatus = {
  running: false,
  startedAt: null,
  lastError: null,
};

function buildWatchlist(sites) {
  const roots = new Set();
  for (const site of sites || []) {
    if (!site?.enabled) continue;
    const hostname = normalizeCtName(site.hostname)?.hostname;
    if (hostname) roots.add(`.${hostname}`);
  }
  roots.add(CERTSPOTTER_CANARY);
  return `${[...roots].sort().join("\n")}\n`;
}

function getCertspotterPaths() {
  const root = path.join(dataDirectory, "certspotter");
  return {
    root,
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
    watchlist: path.join(root, "config", "watchlist"),
  };
}

function writeWatchlist(contents) {
  const paths = getCertspotterPaths();
  fs.mkdirSync(paths.config, { recursive: true });
  fs.mkdirSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.cache, { recursive: true });
  const temporary = `${paths.watchlist}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, paths.watchlist);
  return paths;
}

function setStatus(changes) {
  Object.assign(managerStatus, changes);
  callbacks.onState?.({ ...managerStatus });
}

function safeErrorMessage(value, fallback = "Unknown Cert Spotter error") {
  return String(value || fallback).slice(0, 1000);
}

function validateHookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cert Spotter hook body must be an object");
  }
  if (!["discovered_cert", "error", "malformed_cert"].includes(payload.event)) {
    throw new Error("Unsupported Cert Spotter hook event");
  }
  if (payload.event === "discovered_cert" && !Array.isArray(payload.dns_names)) {
    throw new Error("Cert Spotter certificate event is missing dns_names");
  }
  return {
    event: payload.event,
    dns_names: Array.isArray(payload.dns_names)
      ? payload.dns_names.filter((name) => typeof name === "string")
      : [],
    summary: safeErrorMessage(payload.summary, ""),
    detail: safeErrorMessage(payload.detail, ""),
    log_uri: typeof payload.log_uri === "string" ? payload.log_uri.slice(0, 2000) : "",
  };
}

function authorized(request) {
  const provided = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!hookToken || provided.length !== hookToken.length) return false;
  return Buffer.from(provided).equals(Buffer.from(hookToken));
}

function handleHookRequest(request, response) {
  if (request.method !== "POST" || request.url !== "/event" || !authorized(request)) {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  let totalBytes = 0;
  request.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_HOOK_BYTES) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (totalBytes > MAX_HOOK_BYTES) return;
    try {
      const payload = validateHookPayload(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      await callbacks.onEvent?.(payload);
      response.writeHead(204).end();
    } catch (error) {
      setStatus({ lastError: safeErrorMessage(error.message) });
      response.writeHead(400, { "content-type": "text/plain" }).end("invalid event");
    }
  });
}

function startHookServer() {
  if (hookServer) return Promise.resolve();
  hookToken = randomBytes(32).toString("hex");
  hookServer = http.createServer(handleHookRequest);
  return new Promise((resolve, reject) => {
    hookServer.once("error", reject);
    hookServer.listen(0, "127.0.0.1", () => {
      hookServer.off("error", reject);
      hookServer.on("error", (error) => {
        setStatus({ lastError: safeErrorMessage(error.message) });
      });
      const address = hookServer.address();
      hookUrl = `http://127.0.0.1:${address.port}/event`;
      resolve();
    });
  });
}

function scheduleRestart() {
  if (shuttingDown || restartTimer) return;
  const base = Math.min(MAX_RESTART_MS, 1_000 * 2 ** restartAttempt++);
  const wait = Math.round(base * (0.75 + Math.random() * 0.5));
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launchCertspotter();
  }, wait);
  restartTimer.unref();
}

function launchCertspotter() {
  if (shuttingDown || child) return;
  const paths = writeWatchlist(buildWatchlist(statements.activeSites.all()));
  activeWatchlist = fs.readFileSync(paths.watchlist, "utf8");
  const hookCommand = path.join(__dirname, "certspotter-hook.js");
  const args = [
    "-start_at_end",
    "-no_save",
    "-healthcheck",
    CERTSPOTTER_HEALTH_INTERVAL,
    "-state_dir",
    paths.state,
    "-watchlist",
    paths.watchlist,
    "-script",
    hookCommand,
  ];

  expectedStop = false;
  const spawned = spawn(CERTSPOTTER_BINARY, args, {
    env: {
      ...process.env,
      CERTSPOTTER_CACHE_DIR: paths.cache,
      PAGEPULSE_CT_HOOK_URL: hookUrl,
      PAGEPULSE_CT_HOOK_TOKEN: hookToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = spawned;

  spawned.once("spawn", () => {
    stableTimer = setTimeout(() => {
      stableTimer = null;
      restartAttempt = 0;
    }, 60_000);
    stableTimer.unref();
    setStatus({
      running: true,
      startedAt: new Date().toISOString(),
      lastError: null,
    });
    console.log("[ct] direct Cert Spotter monitor started");
  });
  spawned.stdout.on("data", (chunk) => process.stdout.write(`[certspotter] ${chunk}`));
  spawned.stderr.on("data", (chunk) => process.stderr.write(`[certspotter] ${chunk}`));
  spawned.once("error", (error) => {
    setStatus({ running: false, lastError: safeErrorMessage(error.message) });
  });
  spawned.once("close", (code, signal) => {
    const wasExpected = expectedStop;
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
    child = null;
    setStatus({ running: false });
    if (shuttingDown) return;
    if (!wasExpected) {
      const reason = `Cert Spotter exited (${signal || code})`;
      setStatus({ lastError: reason });
      console.error(`[ct] ${reason}`);
      scheduleRestart();
      return;
    }
    restartAttempt = 0;
    launchCertspotter();
  });
}

async function startCertspotterManager(options = {}) {
  callbacks = options;
  shuttingDown = false;
  stoppingPromise = null;
  await startHookServer();
  launchCertspotter();
}

function refreshCertspotterWatchlist() {
  const nextWatchlist = buildWatchlist(statements.activeSites.all());
  if (nextWatchlist === activeWatchlist) return false;
  writeWatchlist(nextWatchlist);
  activeWatchlist = nextWatchlist;
  if (!hookUrl) return true;
  if (child) {
    expectedStop = true;
    child.kill("SIGTERM");
  } else {
    launchCertspotter();
  }
  return true;
}

function closeHookServer() {
  if (!hookServer) return Promise.resolve();
  const server = hookServer;
  hookServer = null;
  return new Promise((resolve) => server.close(resolve));
}

function stopCertspotterManager() {
  if (stoppingPromise) return stoppingPromise;
  stoppingPromise = (async () => {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (stableTimer) clearTimeout(stableTimer);
    restartTimer = null;
    stableTimer = null;
    if (child) {
      const runningChild = child;
      const closed = new Promise((resolve) => runningChild.once("close", resolve));
      expectedStop = true;
      runningChild.kill("SIGTERM");
      await closed;
    }
    await closeHookServer();
    setStatus({ running: false });
  })();
  return stoppingPromise;
}

function getCertspotterManagerStatus() {
  return { ...managerStatus };
}

module.exports = {
  CERTSPOTTER_CANARY,
  buildWatchlist,
  getCertspotterManagerStatus,
  refreshCertspotterWatchlist,
  startCertspotterManager,
  stopCertspotterManager,
  validateHookPayload,
};
