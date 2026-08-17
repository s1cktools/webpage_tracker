const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const ANSEM_COINS_URL = "https://ansem.io/api/coins";
const execFileAsync = promisify(execFile);
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function normalizeCoins(payload) {
  if (!payload || !Array.isArray(payload.coins)) {
    throw new Error("Ansem returned an invalid coins payload");
  }

  return payload.coins
    .filter((coin) => coin && typeof coin.mint === "string" && coin.mint.trim())
    .map((coin) => ({
      slug: String(coin.slug || "").trim(),
      name: String(coin.name || "Unknown coin").trim(),
      ticker: String(coin.ticker || "").trim(),
      description: coin.description == null ? null : String(coin.description),
      imageUrl: coin.imageUrl == null ? null : String(coin.imageUrl),
      mint: coin.mint.trim(),
      creatorWallet:
        coin.creatorWallet == null ? null : String(coin.creatorWallet),
      status: coin.status == null ? null : String(coin.status),
      createdAt: coin.createdAt == null ? null : String(coin.createdAt),
    }));
}

async function fetchAnsemCoins() {
  // Cloudflare challenges Node's native TLS fingerprint on this endpoint while
  // allowing the same public API request from curl/browser clients.
  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const { stdout } = await execFileAsync(
    executable,
    [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--header",
      "Accept: application/json",
      "--header",
      "Cache-Control: no-cache",
      "--header",
      "Referer: https://ansem.io/",
      "--user-agent",
      BROWSER_USER_AGENT,
      ANSEM_COINS_URL,
    ],
    { maxBuffer: 5 * 1024 * 1024, timeout: 12_000, windowsHide: true }
  );

  return normalizeCoins(JSON.parse(stdout));
}

module.exports = { ANSEM_COINS_URL, fetchAnsemCoins, normalizeCoins };
