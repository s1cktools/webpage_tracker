const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalSiteHostname,
  fetchCrtNameNames,
  fetchHistoricalCtNames,
  isConcreteSubdomainOf,
  isRootAlias,
  isSubdomainOf,
  normalizeCtName,
  parseCrtNameResponse,
  parseCrtShResponse,
  parseSuggestedApex,
  resetCrtNameQuota,
  siteHostnameAliases,
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

test("treats www and apex as the same tracked site", () => {
  assert.equal(canonicalSiteHostname("WWW.SpaceX.com."), "spacex.com");
  assert.equal(canonicalSiteHostname("www.com"), "www.com");
  assert.deepEqual(siteHostnameAliases("www.openai.com"), [
    "openai.com",
    "www.openai.com",
  ]);
  assert.equal(isRootAlias("www.spacex.com", "spacex.com"), true);
  assert.equal(isRootAlias("spacex.com", "www.spacex.com"), true);
  assert.equal(isRootAlias("auth.spacex.com", "spacex.com"), false);
});

test("matches only proper subdomains of the tracked root", () => {
  assert.equal(isSubdomainOf("auth.spacex.com", "spacex.com"), true);
  assert.equal(isSubdomainOf("auth.spacex.com", "www.spacex.com"), true);
  assert.equal(isSubdomainOf("spacex.com", "spacex.com"), false);
  assert.equal(isSubdomainOf("www.spacex.com", "spacex.com"), true);
  assert.equal(isConcreteSubdomainOf("www.spacex.com", "spacex.com"), false);
  assert.equal(isConcreteSubdomainOf("auth.spacex.com", "www.spacex.com"), true);
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

test("parses crt.name json and text payloads", () => {
  assert.deepEqual(
    parseCrtNameResponse([
      { first_seen: "2026-01-01T00:00:00Z", sub: "example.com" },
      { sub: "WWW.Auth.Example.com" },
      { subdomain: "auth.example.com" },
    ]),
    [
      { hostname: "example.com", wildcard: false },
      { hostname: "www.auth.example.com", wildcard: false },
      { hostname: "auth.example.com", wildcard: false },
    ]
  );
  assert.deepEqual(parseCrtNameResponse("api.example.com\n\napi.example.com\n"), [
    { hostname: "api.example.com", wildcard: false },
  ]);
  assert.equal(parseSuggestedApex("invalid apex: not an apex (eTLD+1 is namecheap.com)"), "namecheap.com");
});

test("fetches crt.name and retries with the hinted eTLD+1", async () => {
  resetCrtNameQuota();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const apex = new URL(url, "https://crt.name").searchParams.get("apex");
    calls.push({
      apex,
      authorization: options.headers?.authorization || "",
    });
    if (apex === "shop.example.com") {
      return new Response("invalid apex: not an apex (eTLD+1 is example.com)", {
        status: 400,
        headers: { "x-ratelimit-remaining": "98" },
      });
    }
    return new Response(
      JSON.stringify([
        { sub: "example.com" },
        { sub: "www.example.com" },
        { sub: "shop.example.com" },
        { sub: "www.shop.example.com" },
        { sub: "pay.shop.example.com" },
        { sub: "other.example.com" },
      ]),
      {
        status: 200,
        headers: { "x-ratelimit-remaining": "97" },
      }
    );
  };

  try {
    process.env.CRT_NAME_TOKEN = "test-token";
    const entries = await fetchCrtNameNames("www.shop.example.com");
    assert.deepEqual(
      entries.map((entry) => entry.hostname).sort(),
      ["pay.shop.example.com"]
    );
    assert.deepEqual(
      calls.map((call) => call.apex),
      ["shop.example.com", "example.com"]
    );
    assert.equal(calls[0].authorization, "Bearer test-token");
  } finally {
    delete process.env.CRT_NAME_TOKEN;
    global.fetch = originalFetch;
    resetCrtNameQuota();
  }
});

test("falls back to crt.sh only when a crt.name baseline is required", async () => {
  resetCrtNameQuota();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("crt.name")) {
      return new Response("rate limited", {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      });
    }
    return new Response(
      JSON.stringify([{ name_value: "auth.example.com" }]),
      { status: 200 }
    );
  };

  try {
    await assert.rejects(
      () => fetchHistoricalCtNames("example.com", { allowFallback: false }),
      /429/
    );
    const fallback = await fetchHistoricalCtNames("example.com", {
      allowFallback: true,
    });
    assert.equal(fallback.source, "crt.sh");
    assert.deepEqual(
      fallback.entries.map((entry) => entry.hostname),
      ["auth.example.com"]
    );
  } finally {
    global.fetch = originalFetch;
    resetCrtNameQuota();
  }
});
