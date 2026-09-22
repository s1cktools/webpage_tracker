const {
  getSetting,
  saveWizardProfile,
  statements,
} = require("./db");
const { buildWizardProfilePayload } = require("./discord");
const { postDiscordPayload } = require("./binance-alerts");
const { emitTrackerEvent } = require("./event-stream");
const { buildWebsiteProfileChangeEvent } = require("./events");
const { saveWizardProfileReport } = require("./reports");
const {
  diffWizardSnapshots,
  fetchWizardProfile,
  snapshotFromProfile,
} = require("./wizard");

const WIZARD_POLL_INTERVAL_MS = 5_000;
let scanning = false;

function isWizardEnabled() {
  return getSetting("wizard_profile_enabled") !== "0";
}

async function scanWizardProfile(force = false) {
  if (scanning || (!force && !isWizardEnabled())) return null;
  scanning = true;
  const startedAt = Date.now();
  try {
    const profile = await fetchWizardProfile();
    const snapshot = snapshotFromProfile(profile);
    const state = statements.getWizardProfileState.get();
    let previous = {};
    if (state?.baselined) {
      try {
        previous = JSON.parse(state.snapshot_json || "{}");
      } catch {
        throw new Error("Saved Wizard profile snapshot is invalid");
      }
    }

    const changes = state?.baselined
      ? diffWizardSnapshots(previous, snapshot)
      : [];
    saveWizardProfile(profile, snapshot, changes);

    if (!state?.baselined) {
      console.log(`[wizard] baseline · ${profile.fields.length} profile fields`);
      return { status: "baselined", changes: [] };
    }
    if (!changes.length) return { status: "unchanged", changes: [] };

    const detectedAt = new Date();
    const report = saveWizardProfileReport(profile, changes);
    emitTrackerEvent(
      buildWebsiteProfileChangeEvent(
        profile,
        changes,
        detectedAt,
        report.url
      )
    );

    const webhookUrl = getSetting("discord_webhook_url");
    if (webhookUrl) {
      try {
        await postDiscordPayload(
          webhookUrl,
          buildWizardProfilePayload(
            profile,
            changes,
            Date.now() - startedAt,
            detectedAt,
            report.url
          )
        );
      } catch (error) {
        console.error("[wizard] Discord:", error.message);
      }
    }
    console.log(
      `[wizard] ${changes.length} profile field${changes.length === 1 ? "" : "s"} changed`
    );
    return { status: "changed", changes, reportId: report.id };
  } catch (error) {
    statements.markWizardProfileError.run(String(error.message).slice(0, 500));
    console.error("[wizard]", error.message);
    return { status: "error", error };
  } finally {
    scanning = false;
  }
}

function startWizardScanner() {
  scanWizardProfile();
  const timer = setInterval(scanWizardProfile, WIZARD_POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  WIZARD_POLL_INTERVAL_MS,
  isWizardEnabled,
  scanWizardProfile,
  startWizardScanner,
};
