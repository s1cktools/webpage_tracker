const { promises: dns } = require("node:dns");
const { X509Certificate } = require("node:crypto");
const { domainToASCII } = require("node:url");

const CERTSTREAM_URL =
  "wss://ctlstream.interrupt.sh/stream?filter=sans.dns_names";
const CRT_SH_URL = "https://crt.sh/";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CRT_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_CRT_NAMES = 250_000;

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

function isSubdomainOf(hostname, rootHostname) {
  const name = normalizeCtName(hostname)?.hostname;
  const root = normalizeCtName(rootHostname)?.hostname;
  return Boolean(name && root && name !== root && name.endsWith(`.${root}`));
}

function parseDnsSubjectAltName(value) {
  return [...String(value || "").matchAll(/DNS:([^,\s]+)/g)].map(
    (match) => match[1]
  );
}

function parseCertstreamMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(String(rawMessage));
  } catch {
    return [];
  }
  let names = [];
  if (message?.message_type === "dns_entries" && Array.isArray(message.data)) {
    names = message.data;
  } else if (Array.isArray(message?.sans?.dns_names)) {
    names = message.sans.dns_names;
  } else if (typeof message?.cert_pem === "string") {
    try {
      const certificate = new X509Certificate(message.cert_pem);
      names = parseDnsSubjectAltName(certificate.subjectAltName);
    } catch {
      return [];
    }
  }
  return names.map(normalizeCtName).filter(Boolean);
}

function parseCrtShResponse(records) {
  if (!Array.isArray(records)) return [];
  const unique = new Map();
  for (const record of records) {
    const names = [record?.common_name, record?.name_value]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\r?\n/));
    for (const name of names) {
      const normalized = normalizeCtName(name);
      if (normalized) {
        const key = `${normalized.wildcard ? "*." : ""}${normalized.hostname}`;
        unique.set(key, normalized);
      }
    }
  }
  return [...unique.values()];
}

async function fetchCrtShNames(rootHostname) {
  const root = normalizeCtName(rootHostname)?.hostname;
  if (!root) throw new Error("Invalid root hostname");
  const query = new URL(CRT_SH_URL);
  query.searchParams.set("q", `%.${root}`);
  query.searchParams.set("output", "json");
  query.searchParams.set("deduplicate", "Y");
  const response = await fetch(query, {
    headers: { accept: "application/json", "user-agent": "PagePulse/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`crt.sh returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_CRT_RESPONSE_BYTES) {
    throw new Error("crt.sh response exceeded the 20 MB safety limit");
  }
  if (!response.body) throw new Error("crt.sh returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CRT_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("crt.sh response exceeded the 20 MB safety limit");
    }
    chunks.push(Buffer.from(value));
  }
  const body = Buffer.concat(chunks, totalBytes).toString("utf8");
  return parseCrtShResponse(JSON.parse(body))
    .filter((entry) => !entry.wildcard && isSubdomainOf(entry.hostname, root))
    .slice(0, MAX_CRT_NAMES);
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
  CERTSTREAM_URL,
  fetchCrtShNames,
  isSubdomainOf,
  normalizeCtName,
  parseCertstreamMessage,
  parseCrtShResponse,
  parseDnsSubjectAltName,
  resolveDnsStatus,
};
