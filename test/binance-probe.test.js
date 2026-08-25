const test = require("node:test");
const assert = require("node:assert/strict");
const {
  probeConfig,
  scanProbePump,
  scanProbeNamespace,
} = require("../src/binance-probe");

test("probe runtime does not load primary database modules", () => {
  assert.equal(require.cache[require.resolve("../src/db")], undefined);
});

test("derives Railway probe configuration with minimal variables", () => {
  assert.deepEqual(
    probeConfig({
      BINANCE_PROBE_SECRET: "secret",
      RAILWAY_SERVICE_NAME: "eu-west-probe",
    }),
    {
      primaryUrl: "https://webtracker.up.railway.app",
      secret: "secret",
      probeId: "eu-west-probe",
    }
  );
  assert.throws(() => probeConfig({}), /requires BINANCE_PROBE_SECRET/);
});

test("posts changed snapshots and acknowledges the ETag", async (context) => {
  context.mock.method(global, "fetch", async () => {
    return new Response(JSON.stringify({ title: "fresh" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"v2"',
        "last-modified": "Fri, 21 Aug 2026 13:51:13 GMT",
        "x-amz-version-id": "s3-v2",
      },
    });
  });
  const etags = new Map();
  let posted;
  await scanProbeNamespace(
    "activity-ui",
    etags,
    { probeId: "asia" },
    async (observation) => {
      posted = observation;
    }
  );

  assert.equal(etags.get("activity-ui"), '"v2"');
  assert.equal(posted.namespace, "activity-ui");
  assert.equal(posted.versionId, "s3-v2");
  assert.deepEqual(posted.snapshot, { title: "fresh" });
});

test("does not acknowledge an ETag when primary delivery fails", async (context) => {
  context.mock.method(global, "fetch", async () => {
    return new Response(JSON.stringify({ title: "fresh" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: '"v2"',
        "last-modified": "Fri, 21 Aug 2026 13:51:13 GMT",
      },
    });
  });
  const etags = new Map();

  await assert.rejects(
    scanProbeNamespace(
      "activity-ui",
      etags,
      { probeId: "eu" },
      async () => {
        throw new Error("primary unavailable");
      }
    ),
    /primary unavailable/
  );
  assert.equal(etags.has("activity-ui"), false);
});

test("posts changed Pump manifests and acknowledges only after delivery", async (context) => {
  const previousRuntime = process.env.PUMP_RUNTIME_VERSION;
  process.env.PUMP_RUNTIME_VERSION = "26.0.0";
  context.after(() => {
    if (previousRuntime === undefined) delete process.env.PUMP_RUNTIME_VERSION;
    else process.env.PUMP_RUNTIME_VERSION = previousRuntime;
  });
  context.mock.method(global, "fetch", async () => {
    return new Response(
      JSON.stringify({
        id: "pump-v2",
        runtimeVersion: "26.0.0",
        createdAt: "2026-08-21T15:00:00.000Z",
        launchAsset: {
          hash: "launch-v2",
          key: "launch-key",
          url: "https://assets.example/bundle",
        },
        assets: [],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", etag: '"pump-v2"' },
      }
    );
  });
  const state = { runtimeVersion: null, updateId: null, etag: null };
  let posted;
  await scanProbePump(
    state,
    { probeId: "eu" },
    async (observation) => {
      posted = observation;
    }
  );

  assert.equal(state.updateId, "pump-v2");
  assert.equal(state.etag, '"pump-v2"');
  assert.equal(posted.manifest.launchAsset.hash, "launch-v2");
  assert.equal(posted.probeId, "eu");
});

test("does not acknowledge a Pump update when primary delivery fails", async (context) => {
  const previousRuntime = process.env.PUMP_RUNTIME_VERSION;
  process.env.PUMP_RUNTIME_VERSION = "26.0.0";
  context.after(() => {
    if (previousRuntime === undefined) delete process.env.PUMP_RUNTIME_VERSION;
    else process.env.PUMP_RUNTIME_VERSION = previousRuntime;
  });
  context.mock.method(global, "fetch", async () => {
    return new Response(
      JSON.stringify({
        id: "pump-v2",
        runtimeVersion: "26.0.0",
        createdAt: "2026-08-21T15:00:00.000Z",
        launchAsset: {
          hash: "launch-v2",
          key: "launch-key",
          url: "https://assets.example/bundle",
        },
        assets: [],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", etag: '"pump-v2"' },
      }
    );
  });
  const state = { runtimeVersion: null, updateId: null, etag: null };

  await assert.rejects(
    scanProbePump(state, { probeId: "asia" }, async () => {
      throw new Error("primary unavailable");
    }),
    /primary unavailable/
  );
  assert.equal(state.updateId, null);
  assert.equal(state.etag, null);
});

test("does not post unchanged Pump manifests", async (context) => {
  const previousRuntime = process.env.PUMP_RUNTIME_VERSION;
  process.env.PUMP_RUNTIME_VERSION = "26.0.0";
  context.after(() => {
    if (previousRuntime === undefined) delete process.env.PUMP_RUNTIME_VERSION;
    else process.env.PUMP_RUNTIME_VERSION = previousRuntime;
  });
  context.mock.method(global, "fetch", async () => {
    return new Response(null, { status: 304 });
  });
  const state = {
    runtimeVersion: "26.0.0",
    updateId: "pump-v2",
    etag: '"pump-v2"',
  };
  let posted = false;
  const changed = await scanProbePump(state, { probeId: "us" }, async () => {
    posted = true;
  });

  assert.equal(changed, false);
  assert.equal(posted, false);
});

test("validates probe bearer tokens safely", () => {
  const { isAuthorizedProbe } = require("../src/binance-observations");
  assert.equal(isAuthorizedProbe("Bearer shared", "shared"), true);
  assert.equal(isAuthorizedProbe("Bearer wrong", "shared"), false);
  assert.equal(isAuthorizedProbe("Basic shared", "shared"), false);
  assert.equal(isAuthorizedProbe("Bearer shared", ""), false);
});
