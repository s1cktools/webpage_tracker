const { fetchAnsemCoins } = require("./ansem");
const { addAnsemCoins, getSetting, statements } = require("./db");
const { buildAnsemPayload } = require("./discord");
const { buildAnsemCoinEvent } = require("./events");
const { emitTrackerEvent } = require("./event-stream");

const ANSEM_POLL_INTERVAL_MS = Math.max(
  250,
  Number(process.env.ANSEM_POLL_INTERVAL_MS) || 1_000
);
let scanning = false;

async function sendDiscordAlerts(coins, scanDurationMs) {
  const webhookUrl = getSetting("discord_webhook_url");
  if (!webhookUrl || coins.length === 0) return;

  for (let index = 0; index < coins.length; index += 10) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildAnsemPayload(coins.slice(index, index + 10), scanDurationMs)
      ),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Discord webhook returned ${response.status}`);
    }
  }
}

async function scanAnsemCoins() {
  if (scanning) return;
  scanning = true;
  const startedAt = Date.now();

  try {
    const coins = await fetchAnsemCoins();
    const isBaseline = statements.countAnsemCoins.get().count === 0;
    const inserted = addAnsemCoins(coins, isBaseline);

    if (!isBaseline && inserted.length) {
      const detectedAt = new Date();
      for (const coin of inserted) {
        emitTrackerEvent(buildAnsemCoinEvent(coin, detectedAt));
      }
      await sendDiscordAlerts(inserted, Date.now() - startedAt);
      console.log(
        `[ansem] ${inserted.length} new coin${inserted.length === 1 ? "" : "s"}: ${inserted.map((coin) => coin.mint).join(", ")}`
      );
    } else if (isBaseline) {
      console.log(`[ansem] baseline complete · ${inserted.length} coins`);
    }
  } catch (error) {
    console.error("[ansem]", error.message);
  } finally {
    scanning = false;
  }
}

function startAnsemScanner() {
  scanAnsemCoins();
  const timer = setInterval(scanAnsemCoins, ANSEM_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  ANSEM_POLL_INTERVAL_MS,
  scanAnsemCoins,
  startAnsemScanner,
};
