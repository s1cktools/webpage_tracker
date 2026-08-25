const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ScanTimeoutError,
  runWithScanTimeout,
} = require("../src/scan-timeout");

test("returns a website scan that completes before its deadline", async () => {
  const result = await runWithScanTimeout(async () => "complete", 50);
  assert.equal(result, "complete");
});

test("aborts and rejects a website scan that exceeds its deadline", async () => {
  let receivedSignal;
  const pendingScan = (signal) => {
    receivedSignal = signal;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };

  await assert.rejects(
    runWithScanTimeout(pendingScan, 20),
    (error) =>
      error instanceof ScanTimeoutError &&
      error.message === "website scan timed out after 20ms"
  );
  assert.equal(receivedSignal.aborted, true);
});
