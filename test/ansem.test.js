const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCoins } = require("../src/ansem");
const { buildAnsemPayload } = require("../src/discord");
const { buildAnsemCoinEvent } = require("../src/events");

const coin = {
  slug: "bull",
  name: "The Black Bull",
  ticker: "BULL",
  mint: "8aeoH4Ye4MQ3nxS4YdEMjh6vF75JP8hs39SnJuoNb9ZR",
  creatorWallet: "creator",
  status: "on_curve",
  createdAt: "2026-08-17T16:00:21.000Z",
};

test("normalizes Ansem coins and requires a coins array", () => {
  assert.deepEqual(normalizeCoins({ coins: [coin, { name: "no mint" }] })[0], {
    ...coin,
    description: null,
    imageUrl: null,
  });
  assert.throws(() => normalizeCoins({}), /invalid coins payload/);
});

test("includes the contract address in Ansem notifications", () => {
  const event = buildAnsemCoinEvent(coin);
  assert.equal(event.event_type, "ansem_coin");
  assert.equal(event.data.contract_address, coin.mint);

  const payload = buildAnsemPayload([coin], 42);
  assert.match(payload.embeds[0].description, new RegExp(coin.mint));
});
