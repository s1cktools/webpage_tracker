const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mapBinanceSquarePost, normalizeUsername } = require("../src/binance-square");
const { DEFAULT_BINANCE_SQUARE_TARGETS } = require("../src/binance-square-default-targets");

test("seeds the live Binance Square watchlist", () => {
  assert.equal(DEFAULT_BINANCE_SQUARE_TARGETS.length, 12);
  assert.deepEqual(
    DEFAULT_BINANCE_SQUARE_TARGETS.map((target) => target.username),
    [
      "BSCDaily",
      "CZ",
      "heyi",
      "BinanceCN",
      "binancezh",
      "BinanceWallet",
      "BinanceSquareCN",
      "richardteng",
      "Binance_News",
      "Binance_Angels",
      "Binance_Blog",
      "Binance_Announcement",
    ]
  );
  assert.ok(DEFAULT_BINANCE_SQUARE_TARGETS.every((target) => target.pollIntervalSeconds === 2));
});

test("normalizes Binance Square usernames and profile URLs", () => {
  assert.equal(normalizeUsername("@Binance"), "Binance");
  assert.equal(
    normalizeUsername("https://www.binance.com/en/square/profile/heyi"),
    "heyi"
  );
});

test("maps a Square content payload", () => {
  const post = mapBinanceSquarePost(
    {
      id: "post-1",
      title: null,
      bodyTextOnly: "Hello Square",
      createTime: 1757136784000,
      contentType: 1,
      isStickyToTop: false,
      webLink: "/en/square/post/post-1",
      imageList: ["https://example.test/one.jpg"],
      author: {
        squareUid: "uid-1",
        username: "binance",
        displayName: "Binance",
        avatar: "https://example.test/avatar.png",
      },
    },
    { squareUid: "uid-1", username: "binance", displayName: "Binance", avatar: null }
  );
  assert.equal(post.id, "post-1");
  assert.equal(post.postType, "post");
  assert.equal(post.url, "https://www.binance.com/en/square/post/post-1");
  assert.deepEqual(post.images, ["https://example.test/one.jpg"]);
});

test("archives every Square post ID and only emits real new posts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-square-"));
  process.env.DATA_DIR = directory;
  const { statements } = require("../src/db");
  const { ingestBinanceSquarePage } = require("../src/binance-square-scanner");

  statements.addBinanceSquareTarget.run(
    "uid-1",
    "binance",
    "Binance",
    null,
    null,
    15
  );
  const known = [
    { id: "KnownPost001", title: "Known one", createdAt: 100, isPinned: true },
    { id: "KnownPost002", title: "Known two", createdAt: 200, isPinned: false },
    { id: "KnownPost003", title: "Known three", createdAt: 300, isPinned: false },
  ];

  assert.deepEqual(
    ingestBinanceSquarePage(statements.getBinanceSquareTarget.get("uid-1"), known),
    []
  );
  assert.equal(statements.getBinanceSquareTarget.get("uid-1").baselined, 1);
  assert.equal(statements.getBinanceSquareTarget.get("uid-1").pinned_post_count, 1);
  assert.equal(statements.countBinanceSquarePosts.get().count, 3);

  const fresh = ingestBinanceSquarePage(statements.getBinanceSquareTarget.get("uid-1"), [
    { id: "FreshPost001", title: "Fresh post", createdAt: 400, isPinned: false },
    ...known,
  ]);
  assert.deepEqual(fresh.map((post) => post.id), ["FreshPost001"]);

  const dump = Array.from({ length: 20 }, (_, index) => ({
    id: `DumpPost${String(index).padStart(4, "0")}`,
    title: `Dump ${index}`,
    createdAt: 500 + index,
    isPinned: false,
  }));
  assert.deepEqual(
    ingestBinanceSquarePage(statements.getBinanceSquareTarget.get("uid-1"), dump),
    []
  );
  assert.equal(statements.countBinanceSquarePosts.get().count, 24);
  assert.deepEqual(
    ingestBinanceSquarePage(statements.getBinanceSquareTarget.get("uid-1"), dump),
    []
  );
  assert.equal(statements.countBinanceSquarePosts.get().count, 24);
});
