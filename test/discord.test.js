const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDiscordPayload } = require("../src/discord");

const site = {
  hostname: "openai.com",
  nickname: "OpenAI",
};
const now = new Date("2026-08-17T09:20:00.000Z");

test("builds a clean single-page embed using the site nickname", () => {
  const payload = buildDiscordPayload(
    site,
    ["https://openai.com/research/gpt-6"],
    now
  );

  assert.equal(payload.embeds[0].title, "New OpenAI Page Detected");
  assert.equal(payload.embeds[0].url, "https://openai.com/research/gpt-6");
  assert.match(payload.embeds[0].description, /research\/gpt-6/);
  assert.equal(payload.username, "the watcher");
  assert.equal(payload.embeds[0].footer.text, "openai.com");
});

test("builds a capped multi-page embed", () => {
  const urls = Array.from(
    { length: 12 },
    (_, index) => `https://openai.com/page-${index + 1}`
  );
  const payload = buildDiscordPayload(site, urls, now);

  assert.equal(payload.embeds[0].title, "12 New OpenAI Pages Detected");
  assert.match(payload.embeds[0].description, /\+2 more URLs/);
  assert.doesNotMatch(payload.embeds[0].description, /page-11/);
});

test("uses fetched titles for new page labels", () => {
  const url = "https://openai.com/research/gpt-6";
  const titles = new Map([[url, "Introducing GPT-6"]]);
  const payload = buildDiscordPayload(site, [url], now, titles);

  assert.equal(payload.embeds[0].title, "Introducing GPT-6");
  assert.match(payload.embeds[0].description, /Introducing GPT-6/);
});
