const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("hub observations dedupe, dump-fuse, and ignore repeat Binance versions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-obs-"));
  process.env.DATA_DIR = directory;
  const { statements } = require("../src/db");
  const { applyObservations } = require("../src/observations");

  try {
    statements.addYouTubeChannel.run(
      "UCXZCJLdBC09xxGZ6gcdrc6A",
      "@OpenAI",
      "OpenAI",
      15
    );
    const channelId = "UCXZCJLdBC09xxGZ6gcdrc6A";
    const known = [
      { videoId: "KnownVid001", title: "Known one" },
      { videoId: "KnownVid002", title: "Known two" },
      { videoId: "KnownVid003", title: "Known three" },
    ];

    const baseline = await applyObservations({
      satellite_id: "vps-1",
      items: [{ kind: "youtube_video", channel_id: channelId, videos: known }],
    });
    assert.equal(baseline.accepted, 1);
    assert.equal(baseline.emitted, 0);
    assert.equal(statements.getYouTubeChannel.get(channelId).baselined, 1);
    assert.equal(statements.countYouTubeVideos.get().count, 3);

    const knownAgain = await applyObservations({
      satellite_id: "vps-1",
      items: [{ kind: "youtube_video", channel_id: channelId, videos: known }],
    });
    assert.equal(knownAgain.emitted, 0);
    assert.equal(knownAgain.inserted, 0);
    assert.equal(statements.countYouTubeVideos.get().count, 3);

    const oneNew = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "youtube_video",
          channel_id: channelId,
          videos: [{ videoId: "FreshVid001", title: "Fresh upload" }, ...known],
        },
      ],
    });
    assert.equal(oneNew.emitted, 1);
    assert.equal(oneNew.inserted, 1);
    assert.equal(statements.countYouTubeVideos.get().count, 4);

    const dump = Array.from({ length: 20 }, (_, index) => ({
      videoId: `DumpVid${String(index).padStart(4, "0")}`,
      title: `Dump ${index}`,
    }));
    const fused = await applyObservations({
      satellite_id: "vps-1",
      items: [{ kind: "youtube_video", channel_id: channelId, videos: dump }],
    });
    assert.equal(fused.emitted, 0);
    assert.equal(statements.countYouTubeVideos.get().count, 24);

    const siteId = Number(
      statements.addSite.run("https://example.com/", "example.com", "Example")
        .lastInsertRowid
    );
    const knownUrl = "https://example.com/known";
    const firstPage = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "website_page",
          site_id: siteId,
          urls: [{ url: knownUrl, title: "Known page" }],
        },
      ],
    });
    assert.equal(firstPage.emitted, 0);
    statements.markBaselined.run(siteId);

    const knownPage = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "website_page",
          site_id: siteId,
          urls: [{ url: knownUrl, title: "Known page" }],
        },
        { kind: "website_page", site_id: 999999, urls: ["https://missing.test/"] },
      ],
    });
    assert.equal(knownPage.emitted, 0);
    assert.equal(knownPage.inserted, 0);
    assert.equal(knownPage.accepted, 1);
    assert.equal(knownPage.errors.length, 1);
    assert.equal(knownPage.errors[0].index, 1);
    assert.match(knownPage.errors[0].error, /Unknown site_id/);

    const sourceBaseline = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "website_page",
          site_id: siteId,
          playbook_key: "example",
          source_key: "new-feed",
          urls: [{ url: "https://example.com/feed-first", title: "Feed baseline" }],
        },
      ],
    });
    assert.equal(sourceBaseline.inserted, 1);
    assert.equal(sourceBaseline.emitted, 0);

    const sourceFollowUp = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "website_page",
          site_id: siteId,
          playbook_key: "example",
          source_key: "new-feed",
          urls: [{ url: "https://example.com/feed-next", title: "Feed update" }],
        },
      ],
    });
    assert.equal(sourceFollowUp.inserted, 1);
    assert.equal(sourceFollowUp.emitted, 1);

    const websiteDump = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "website_page",
          site_id: siteId,
          playbook_key: "example",
          source_key: "new-feed",
          urls: Array.from({ length: 20 }, (_, index) => ({
            url: `https://example.com/catalog-${index}`,
            title: `Catalog ${index}`,
          })),
        },
      ],
    });
    assert.equal(websiteDump.inserted, 20);
    assert.equal(websiteDump.emitted, 0);

    const namespace = "activity-ui";
    const firstUi = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "binance_ui",
          namespace,
          etag: '"etag-1"',
          version_id: "version-1",
          last_modified: "2026-09-06T00:00:00.000Z",
          data: { greeting: "hello" },
        },
      ],
    });
    assert.equal(firstUi.emitted, 0);
    assert.equal(statements.getBinanceNamespace.get(namespace).baselined, 1);

    const repeatEtag = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "binance_ui",
          namespace,
          etag: '"etag-1"',
          version_id: "version-1",
          last_modified: "2026-09-06T00:00:00.000Z",
          data: { greeting: "stale replay" },
        },
      ],
    });
    assert.equal(repeatEtag.emitted, 0);
    assert.equal(repeatEtag.inserted, 0);
    assert.equal(
      JSON.parse(statements.getBinanceNamespace.get(namespace).snapshot_json).greeting,
      "hello"
    );

    const freshEtag = await applyObservations({
      satellite_id: "vps-1",
      items: [
        {
          kind: "binance_ui",
          namespace,
          etag: '"etag-2"',
          version_id: "version-2",
          last_modified: "2026-09-06T00:01:00.000Z",
          data: { greeting: "updated" },
        },
      ],
    });
    assert.equal(freshEtag.emitted, 1);
    assert.equal(freshEtag.inserted, 1);

    await applyObservations({ satellite_id: "vps-1", items: [] });
    const satellites = statements.listSatellites.all();
    assert.equal(satellites.length, 1);
    assert.equal(satellites[0].id, "vps-1");
    assert.ok(satellites[0].last_seen_at);
    assert.deepEqual(JSON.parse(satellites[0].last_kinds_json), ["binance_ui"]);
  } finally {
    const { db } = require("../src/db");
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
