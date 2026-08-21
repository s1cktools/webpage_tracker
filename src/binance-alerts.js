const { getSetting } = require("./db");
const { buildBinancePayload } = require("./discord");

async function postDiscordPayload(webhookUrl, payload) {
  let response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const waitMs = Math.min(Number(body.retry_after) * 1_000 || 1_000, 15_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  }
  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}`);
  }
}

async function sendBinanceAlerts(events, scanDurationMs) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || events.length === 0) return;

  for (let index = 0; index < events.length; index += 5) {
    const batch = events.slice(index, index + 5);
    await postDiscordPayload(
      webhookUrl,
      buildBinancePayload(batch, scanDurationMs)
    );
  }
}

module.exports = { postDiscordPayload, sendBinanceAlerts };
