const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BINANCE_APP_NAMESPACE,
  BINANCE_APP_URL,
  BINANCE_UI_NAMESPACES,
  diffObjects,
  fetchBinanceNamespace,
  parseAndroidStrings,
} = require("../src/binance");
const {
  buildBinancePayload,
  formatBinanceChanges,
} = require("../src/discord");

test("includes the discovered Binance UI namespaces", () => {
  assert.ok(BINANCE_UI_NAMESPACES.includes("activity-ui"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("stock_landing_page"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("growth-game-ui"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("MPC-wallet"));
  assert.ok(BINANCE_UI_NAMESPACES.includes("trade-ui"));
  assert.ok(BINANCE_UI_NAMESPACES.includes(BINANCE_APP_NAMESPACE));
  assert.equal(new Set(BINANCE_UI_NAMESPACES).size, BINANCE_UI_NAMESPACES.length);
  assert.equal(BINANCE_UI_NAMESPACES.length, 40);
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
    return new Response(null, {
      status: 304,
      headers: {
        etag: '"saved"',
        "last-modified": "Fri, 21 Aug 2026 13:51:13 GMT",
        "x-amz-version-id": "s3-version",
      },
    });
  });

  const result = await fetchBinanceNamespace("activity-ui", '"saved"');
  assert.equal(headers["if-none-match"], '"saved"');
  assert.equal(result.unchanged, true);
  assert.equal(result.versionId, "s3-version");
  assert.equal(result.lastModified, "Fri, 21 Aug 2026 13:51:13 GMT");
});

test("parses and fetches the native Binance app translations", async (context) => {
  let requestedUrl;
  let headers;
  context.mock.method(global, "fetch", async (url, options) => {
    requestedUrl = url;
    headers = options.headers;
    return new Response(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<resources>",
        '  <string name="content_coin_label_guide_title">Reply stands out!</string>',
        '  <string name="escaped">Trade &amp; Earn</string>',
        "</resources>",
      ].join("\n"),
      {
        status: 200,
        headers: {
          etag: '"native-etag"',
          "last-modified": "Fri, 21 Aug 2026 13:51:13 GMT",
          "x-amz-version-id": "native-version",
        },
      }
    );
  });

  const result = await fetchBinanceNamespace(BINANCE_APP_NAMESPACE);
  assert.equal(requestedUrl, BINANCE_APP_URL);
  assert.equal(headers.accept, "application/xml");
  assert.equal(result.etag, '"native-etag"');
  assert.equal(result.versionId, "native-version");
  assert.deepEqual(result.data, {
    content_coin_label_guide_title: "Reply stands out!",
    escaped: "Trade & Earn",
  });
});

test("parses multiline Android string resources", () => {
  assert.deepEqual(
    parseAndroidStrings(
      '<resources><string name="body">First line\nSecond line</string></resources>'
    ),
    { body: "First line\nSecond line" }
  );
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
