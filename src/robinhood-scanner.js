const { getSetting, statements } = require("./db");
const { ingestRobinhoodPages } = require("./observations");
const { discoverRobinhood } = require("./robinhood");

const ROBINHOOD_POLL_INTERVAL_MS = 5_000;
let scanning = false;

function isRobinhoodEnabled() {
  return getSetting("robinhood_pages_enabled") !== "0";
}

async function scanRobinhood(force = false) {
  if (scanning || (!force && !isRobinhoodEnabled())) return;
  scanning = true;
  const startedAt = Date.now();
  const previous = statements.getRobinhoodState.get();

  try {
    const result = await discoverRobinhood({
      baselined: Boolean(previous.baselined),
      brandBuildId: previous.brand_build_id,
      homeEtag: previous.home_etag,
      learnBuildId: previous.learn_build_id,
      learnEtag: previous.learn_etag,
      loginEtag: previous.login_etag,
      robotsEtag: previous.robots_etag,
      runtimeUrl: previous.runtime_url,
      sitemapEtag: previous.sitemap_etag,
      sourcesJson: previous.sources_json,
    });

    if (result.unchanged) {
      statements.markRobinhoodUnchanged.run();
      return;
    }

    if (!previous.baselined && result.pages.length === 0) {
      throw new Error(result.issues[0] || "Robinhood baseline was empty");
    }

    const ingested = await ingestRobinhoodPages(
      result.pages,
      !previous.baselined,
      { startedAt }
    );
    statements.saveRobinhoodState.run(
      result.homeEtag,
      result.loginEtag,
      result.learnEtag,
      result.robotsEtag,
      result.sitemapEtag,
      result.brandBuildId,
      result.learnBuildId,
      result.runtimeUrl,
      JSON.stringify(result.sources),
      result.pages.length
    );

    if (!previous.baselined) {
      console.log(`[robinhood] baseline saved: ${result.pages.length} pages`);
      return;
    }
    if (!ingested.items.length) return;

    console.log(`[robinhood] ${ingested.items.length} new page${ingested.items.length === 1 ? "" : "s"}`);
  } catch (error) {
    statements.markRobinhoodError.run(String(error.message).slice(0, 500));
    console.error("[robinhood]", error.message);
  } finally {
    scanning = false;
  }
}

function startRobinhoodScanner() {
  scanRobinhood();
  const timer = setInterval(scanRobinhood, ROBINHOOD_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  ROBINHOOD_POLL_INTERVAL_MS,
  isRobinhoodEnabled,
  scanRobinhood,
  startRobinhoodScanner,
};
