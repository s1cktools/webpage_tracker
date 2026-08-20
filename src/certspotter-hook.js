#!/usr/bin/env node

const fs = require("node:fs/promises");

const MAX_INPUT_BYTES = 20 * 1024 * 1024;

async function readSmallFile(filename) {
  if (!filename) return "";
  const stat = await fs.stat(filename);
  if (stat.size > MAX_INPUT_BYTES) throw new Error("Cert Spotter hook file is too large");
  return fs.readFile(filename, "utf8");
}

function getHookUrl() {
  const url = new URL(process.env.PAGEPULSE_CT_HOOK_URL || "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Invalid PagePulse CT hook URL");
  }
  return url;
}

async function buildPayload(environment = process.env) {
  const payload = {
    event: environment.EVENT || "",
    summary: environment.SUMMARY || "",
    log_uri: environment.LOG_URI || "",
    dns_names: [],
    detail: "",
  };

  if (payload.event === "discovered_cert") {
    const certificate = JSON.parse(await readSmallFile(environment.JSON_FILENAME));
    payload.dns_names = Array.isArray(certificate.dns_names) ? certificate.dns_names : [];
  } else if (environment.TEXT_FILENAME) {
    payload.detail = await readSmallFile(environment.TEXT_FILENAME);
  }
  return payload;
}

async function main() {
  const token = process.env.PAGEPULSE_CT_HOOK_TOKEN;
  if (!token) throw new Error("Missing PagePulse CT hook token");
  const response = await fetch(getHookUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(await buildPayload()),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`PagePulse CT hook returned ${response.status}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ct-hook] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildPayload, getHookUrl, readSmallFile };
