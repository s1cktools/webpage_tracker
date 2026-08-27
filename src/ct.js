const { promises: dns } = require("node:dns");
const { domainToASCII } = require("node:url");

const CRT_SH_URL = "https://crt.sh/";
const CRT_NAME_URL = "https://crt.name/v1/search";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CRT_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_CRT_NAMES = 250_000;
const CRT_NAME_DAILY_LIMIT = 100;

const crtNameState = {
  remaining: null,
  limitedUntil: 0,
};

function normalizeCtName(value) {
  let name = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  const wildcard = name.startsWith("*.");
  if (wildcard) name = name.slice(2);
  const hostname = domainToASCII(name);
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes("..") ||
    !hostname.includes(".") ||
    !/^[a-z0-9.-]+$/.test(hostname) ||
    hostname.split(".").some((label) => !label || label.length > 63)
  ) {
    return null;
  }
  return { hostname, wildcard };
}

function stripWwwLabel(hostname) {
  const name = String(hostname || "");
  if (!name.startsWith("www.")) return name;
  const rest = name.slice(4);
  return rest.includes(".") ? rest : name;
}

function canonicalSiteHostname(value) {
  const hostname = normalizeCtName(value)?.hostname;
  return hostname ? stripWwwLabel(hostname) : null;
}

function siteHostnameAliases(value) {
  const canonical = canonicalSiteHostname(value);
  if (!canonical) return [];
  return canonical.startsWith("www.") ? [canonical] : [canonical, `www.${canonical}`];
}

function isRootAlias(hostname, rootHostname) {
  const name = normalizeCtName(hostname)?.hostname;
  const root = canonicalSiteHostname(rootHostname);
  return Boolean(name && root && (name === root || name === `www.${root}`));
}

function isSubdomainOf(hostname, rootHostname) {
  const name = normalizeCtName(hostname)?.hostname;
  const root = canonicalSiteHostname(rootHostname);
  return Boolean(name && root && name !== root && name.endsWith(`.${root}`));
}

function isConcreteSubdomainOf(hostname, rootHostname) {
  return (
    isSubdomainOf(hostname, rootHostname) && !isRootAlias(hostname, rootHostname)
  );
}

function nextUtcMidnightMs(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function getCrtNameQuota() {
  if (crtNameState.limitedUntil && crtNameState.limitedUntil <= Date.now()) {
    crtNameState.limitedUntil = 0;
    if (crtNameState.remaining === 0) crtNameState.remaining = null;
  }
  return { ...crtNameState, dailyLimit: CRT_NAME_DAILY_LIMIT };
}

function resetCrtNameQuota() {
  crtNameState.remaining = null;
  crtNameState.limitedUntil = 0;
}

function markCrtNameLimited() {
  crtNameState.remaining = 0;
  crtNameState.limitedUntil = nextUtcMidnightMs();
}

function recordCrtNameHeaders(response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining != null && remaining !== "") {
    const value = Number(remaining);
    if (Number.isFinite(value)) crtNameState.remaining = value;
  }
  if (response.status === 429 || crtNameState.remaining === 0) {
    markCrtNameLimited();
  }
}

function assertCrtNameBudget() {
  const quota = getCrtNameQuota();
  if (quota.remaining === 0 && quota.limitedUntil > Date.now()) {
    const error = new Error("crt.name daily request limit reached");
    error.status = 429;
    throw error;
  }
}

function uniqueNormalizedNames(names) {
  const unique = new Map();
  for (const name of names) {
    const normalized = normalizeCtName(name);
    if (normalized) {
      const key = `${normalized.wildcard ? "*." : ""}${normalized.hostname}`;
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

function relevantCtNames(entries, rootHostname) {
  const root = canonicalSiteHostname(rootHostname);
  if (!root) return [];
  return entries
    .filter((entry) => !entry.wildcard && isConcreteSubdomainOf(entry.hostname, root))
    .slice(0, MAX_CRT_NAMES);
}

function parseCrtShResponse(records) {
  if (!Array.isArray(records)) return [];
  const names = [];
  for (const record of records) {
    names.push(
      ...[record?.common_name, record?.name_value]
        .filter(Boolean)
        .flatMap((value) => String(value).split(/\r?\n/))
    );
  }
  return uniqueNormalizedNames(names);
}

function parseCrtNameResponse(payload) {
  const names = [];
  if (typeof payload === "string") {
    names.push(...payload.split(/\r?\n/));
  } else if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === "string") names.push(item);
      else if (item?.sub) names.push(item.sub);
      else if (item?.subdomain) names.push(item.subdomain);
    }
  }
  return uniqueNormalizedNames(names);
}

function parseSuggestedApex(message) {
  const match = String(message || "").match(/eTLD\+1 is ([a-z0-9.-]+)/i);
  return normalizeCtName(match?.[1])?.hostname || null;
}

function isSuffixApex(hostname, apex) {
  return hostname === apex || hostname.endsWith(`.${apex}`);
}

async function readLimitedBody(response, label) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_CRT_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the 20 MB safety limit`);
  }
  if (!response.body) throw new Error(`${label} returned an empty response`);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CRT_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`${label} response exceeded the 20 MB safety limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function statusError(label, status, detail = "") {
  const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
  const error = new Error(`${label} returned ${status}${suffix}`);
  error.status = status;
  return error;
}

async function fetchCrtShNames(rootHostname) {
  const root = canonicalSiteHostname(rootHostname);
  if (!root) throw new Error("Invalid root hostname");
  const query = new URL(CRT_SH_URL);
  query.searchParams.set("q", `%.${root}`);
  query.searchParams.set("output", "json");
  query.searchParams.set("deduplicate", "Y");
  const response = await fetch(query, {
    headers: { accept: "application/json", "user-agent": "PagePulse/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw statusError("crt.sh", response.status);
  return relevantCtNames(parseCrtShResponse(JSON.parse(await readLimitedBody(response, "crt.sh"))), root);
}

function crtNameHeaders() {
  const headers = {
    accept: "application/json",
    "user-agent": "PagePulse/1.0",
  };
  const token = String(process.env.CRT_NAME_TOKEN || "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function requestCrtName(apex) {
  assertCrtNameBudget();
  const query = new URL(CRT_NAME_URL);
  query.searchParams.set("apex", apex);
  query.searchParams.set("format", "json");
  const response = await fetch(query, {
    headers: crtNameHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  recordCrtNameHeaders(response);
  const body = await readLimitedBody(response, "crt.name");
  if (response.status === 429) throw statusError("crt.name", 429, body);
  if (!response.ok) {
    const error = statusError("crt.name", response.status, body);
    error.body = body;
    throw error;
  }
  return body;
}

async function fetchCrtNameNames(rootHostname) {
  const root = canonicalSiteHostname(rootHostname);
  if (!root) throw new Error("Invalid root hostname");
  let body;
  try {
    body = await requestCrtName(root);
  } catch (error) {
    if (error.status !== 400) throw error;
    const suggested = parseSuggestedApex(error.body || error.message);
    if (!suggested || suggested === root || !isSuffixApex(root, suggested)) throw error;
    body = await requestCrtName(suggested);
  }
  return relevantCtNames(parseCrtNameResponse(JSON.parse(body)), root);
}

async function fetchHistoricalCtNames(rootHostname, { allowFallback = true } = {}) {
  try {
    return { entries: await fetchCrtNameNames(rootHostname), source: "crt.name" };
  } catch (error) {
    if (!allowFallback) throw error;
    try {
      return { entries: await fetchCrtShNames(rootHostname), source: "crt.sh" };
    } catch {
      throw error;
    }
  }
}

async function resolveDnsStatus(hostname) {
  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  if (
    results.some(
      (result) => result.status === "fulfilled" && result.value.length > 0
    )
  ) {
    return "resolved";
  }
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.code);
  return errors.every((code) => code === "ENODATA" || code === "ENOTFOUND")
    ? "unresolved"
    : "unknown";
}

module.exports = {
  CRT_NAME_DAILY_LIMIT,
  canonicalSiteHostname,
  fetchCrtNameNames,
  fetchCrtShNames,
  fetchHistoricalCtNames,
  getCrtNameQuota,
  isConcreteSubdomainOf,
  isRootAlias,
  isSubdomainOf,
  normalizeCtName,
  parseCrtNameResponse,
  parseCrtShResponse,
  parseSuggestedApex,
  resetCrtNameQuota,
  resolveDnsStatus,
  siteHostnameAliases,
  stripWwwLabel,
};
