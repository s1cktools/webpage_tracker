const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BINANCE_UI_NAMESPACES,
  diffObjects,
  fetchBinanceNamespace,
} = require("../src/binance");
const {
  buildBinancePayload,
  formatBinanceChanges,
} = require("../src/discord");

test("includes the discovered Binance UI namespaces", () => {
  assert.ok(BINANCE_UI_NAMESPACES.includes("activity-ui"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("stock_landing_page"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("growth-game-ui"));
  assert.equal(new Set(BINANCE_UI_NAMESPACES).size, BINANCE_UI_NAMESPACES.length);
  assert.equal(BINANCE_UI_NAMESPACES.length, 31);
});

test("diffs added, changed and removed UI values", () => {
  assert.deepEqual(
    diffObjects(
      { removed: "gone", changed: "before", stable: "same" },
      { added: "new", changed: "after", stable: "same" }
    ),
    [
      { type: "added", key: "added", newValue: "new" },
      {
        type: "changed",
        key: "changed",
        oldValue: "before",
        newValue: "after",
      },
      { type: "removed", key: "removed", oldValue: "gone" },
    ]
  );
});

test("uses Binance ETags for unchanged checks", async (context) => {
  let headers;
  context.mock.method(global, "fetch", async (_url, options) => {
    headers = options.headers;
    return new Response(null, { status: 304 });
  });

  const result = await fetchBinanceNamespace("activity-ui", '"saved"');
  assert.equal(headers["if-none-match"], '"saved"');
  assert.equal(result.unchanged, true);
});

test("builds concise Binance UI Discord summaries", () => {
  const changes = [
    { type: "added", key: "new-title", newValue: "New feature" },
    {
      type: "changed",
      key: "description",
      oldValue: "Before",
      newValue: "After",
    },
  ];
  const summary = formatBinanceChanges(changes);
  assert.match(summary, /\+1 added · ~1 changed · -0 removed/);
  assert.match(summary, /\+ new-title = New feature/);

  const payload = buildBinancePayload(
    [{ namespace: "activity-ui", changes }],
    125,
    new Date("2026-08-17T11:00:00.000Z")
  );
  assert.equal(payload.embeds[0].title, "activity-ui updated");
  assert.equal(payload.embeds[0].footer.text, "BINANCE UI · i18n · 125ms");
});
