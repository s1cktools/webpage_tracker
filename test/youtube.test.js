const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extractChannelId,
  extractHandle,
  extractInnerTubeVideos,
} = require("../src/youtube");

test("parses YouTube handles and channel IDs", () => {
  assert.equal(extractHandle("https://youtube.com/@OpenAI/videos"), "@OpenAI");
  assert.equal(
    extractChannelId("https://youtube.com/channel/UCXZCJLdBC09xxGZ6gcdrc6A"),
    "UCXZCJLdBC09xxGZ6gcdrc6A"
  );
});

test("extracts InnerTube uploads", () => {
  const videos = extractInnerTubeVideos(
    {
      videoRenderer: {
        videoId: "AbCdEfGhI12",
        title: { simpleText: "InnerTube upload" },
        thumbnail: { thumbnails: [{ url: "https://example.test/thumb.jpg" }] },
      },
    },
    { channelId: "UCXZCJLdBC09xxGZ6gcdrc6A", title: "OpenAI" }
  );
  assert.equal(videos[0].title, "InnerTube upload");
  assert.equal(videos[0].thumbnailUrl, "https://example.test/thumb.jpg");
});

test("archives every video ID and only emits real new uploads", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagepulse-youtube-"));
  process.env.DATA_DIR = directory;
  const { statements } = require("../src/db");
  const { ingestYouTubePage } = require("../src/youtube-scanner");

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

  assert.deepEqual(
    ingestYouTubePage(statements.getYouTubeChannel.get(channelId), known),
    []
  );
  assert.equal(statements.getYouTubeChannel.get(channelId).baselined, 1);
  assert.equal(statements.countYouTubeVideos.get().count, 3);

  const fresh = ingestYouTubePage(statements.getYouTubeChannel.get(channelId), [
    { videoId: "FreshVid001", title: "Fresh upload" },
    ...known,
  ]);
  assert.deepEqual(fresh.map((video) => video.videoId), ["FreshVid001"]);

  const dump = Array.from({ length: 20 }, (_, index) => ({
    videoId: `DumpVid${String(index).padStart(4, "0")}`,
    title: `Dump ${index}`,
  }));
  assert.deepEqual(
    ingestYouTubePage(statements.getYouTubeChannel.get(channelId), dump),
    []
  );
  assert.equal(statements.countYouTubeVideos.get().count, 24);
  assert.deepEqual(
    ingestYouTubePage(statements.getYouTubeChannel.get(channelId), dump),
    []
  );
  assert.equal(statements.countYouTubeVideos.get().count, 24);
});
