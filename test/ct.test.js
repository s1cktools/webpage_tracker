const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSubdomainOf,
  normalizeCtName,
  parseCrtShResponse,
} = require("../src/ct");

test("normalizes CT names and identifies wildcard observations", () => {
  assert.deepEqual(normalizeCtName("  AUTH.Example.COM. "), {
    hostname: "auth.example.com",
    wildcard: false,
  });
  assert.deepEqual(normalizeCtName("*.API.Example.com"), {
    hostname: "api.example.com",
    wildcard: true,
  });
  assert.equal(normalizeCtName("not a hostname"), null);
});

test("matches only proper subdomains of the tracked root", () => {
  assert.equal(isSubdomainOf("auth.spacex.com", "spacex.com"), true);
  assert.equal(isSubdomainOf("spacex.com", "spacex.com"), false);
  assert.equal(isSubdomainOf("fake-spacex.com", "spacex.com"), false);
  assert.equal(isSubdomainOf("auth.spacex.com.evil.test", "spacex.com"), false);
});

test("parses and deduplicates crt.sh names", () => {
  const entries = parseCrtShResponse([
    {
      common_name: "auth.example.com",
      name_value: "auth.example.com\napi.example.com",
    },
    { name_value: "*.example.com\napi.example.com" },
  ]);
  assert.deepEqual(entries, [
    { hostname: "auth.example.com", wildcard: false },
    { hostname: "api.example.com", wildcard: false },
    { hostname: "example.com", wildcard: true },
  ]);
});
