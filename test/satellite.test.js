const test = require("node:test");
const assert = require("node:assert/strict");
const { getSatelliteConfig, isSatelliteRole } = require("../src/satellite");

test("satellite runtime stays stateless and has zero-config hub defaults", () => {
  assert.equal(require.cache[require.resolve("../src/db")], undefined);

  const previous = {
    role: process.env.PAGEPULSE_ROLE,
    url: process.env.WEBPAGE_TRACKER_URL,
    eventToken: process.env.EVENT_STREAM_TOKEN,
    trackerToken: process.env.WEBPAGE_TRACKER_TOKEN,
  };
  try {
    process.env.PAGEPULSE_ROLE = "satellite";
    delete process.env.WEBPAGE_TRACKER_URL;
    delete process.env.EVENT_STREAM_TOKEN;
    delete process.env.WEBPAGE_TRACKER_TOKEN;

    assert.equal(isSatelliteRole(), true);
    const config = getSatelliteConfig();
    assert.equal(config.hubUrl, "https://webtracker.up.railway.app");
    assert.ok(config.id);
    assert.ok(config.token);
  } finally {
    if (previous.role === undefined) delete process.env.PAGEPULSE_ROLE;
    else process.env.PAGEPULSE_ROLE = previous.role;
    if (previous.url === undefined) delete process.env.WEBPAGE_TRACKER_URL;
    else process.env.WEBPAGE_TRACKER_URL = previous.url;
    if (previous.eventToken === undefined) delete process.env.EVENT_STREAM_TOKEN;
    else process.env.EVENT_STREAM_TOKEN = previous.eventToken;
    if (previous.trackerToken === undefined) delete process.env.WEBPAGE_TRACKER_TOKEN;
    else process.env.WEBPAGE_TRACKER_TOKEN = previous.trackerToken;
  }
});
