const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSubdomainOf,
  normalizeCtName,
  parseCertstreamMessage,
  parseCrtShResponse,
  parseDnsSubjectAltName,
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

test("parses domains-only Certstream messages safely", () => {
  const entries = parseCertstreamMessage(
    JSON.stringify({
      message_type: "dns_entries",
      data: ["auth.example.com", "*.example.com"],
    })
  );
  assert.deepEqual(entries, [
    { hostname: "auth.example.com", wildcard: false },
    { hostname: "example.com", wildcard: true },
  ]);
  assert.deepEqual(parseCertstreamMessage("invalid"), []);
  assert.deepEqual(
    parseCertstreamMessage(JSON.stringify({ message_type: "heartbeat" })),
    []
  );
  assert.deepEqual(
    parseCertstreamMessage(
      JSON.stringify({ sans: { dns_names: ["login.example.com"] } })
    ),
    [{ hostname: "login.example.com", wildcard: false }]
  );
});

test("extracts DNS names from streamed certificate SANs", () => {
  assert.deepEqual(
    parseDnsSubjectAltName("DNS:auth.example.com, DNS:api.example.com, IP Address:127.0.0.1"),
    ["auth.example.com", "api.example.com"]
  );
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
