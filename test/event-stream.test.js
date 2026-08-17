const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attachEventStream,
  emitTrackerEvent,
  tokensMatch,
} = require("../src/event-stream");

test("compares event stream tokens safely", () => {
  assert.equal(tokensMatch("secret", "secret"), true);
  assert.equal(tokensMatch("wrong", "secret"), false);
  assert.equal(tokensMatch("", "secret"), false);
});

test("authenticates subscribers and broadcasts tracker events", (context) => {
  const namespace = {
    emitted: [],
    use(handler) {
      this.middleware = handler;
    },
    on(name, handler) {
      this.handlers ||= {};
      this.handlers[name] = handler;
    },
    emit(name, payload) {
      this.emitted.push({ name, payload });
    },
  };
  class FakeServer {
    of(name) {
      assert.equal(name, "/events");
      return namespace;
    }
  }

  const previousToken = process.env.EVENT_STREAM_TOKEN;
  process.env.EVENT_STREAM_TOKEN = "stream-secret";
  context.after(() => {
    if (previousToken === undefined) delete process.env.EVENT_STREAM_TOKEN;
    else process.env.EVENT_STREAM_TOKEN = previousToken;
  });

  attachEventStream({}, FakeServer);

  let authorizedError;
  namespace.middleware(
    { handshake: { auth: { token: "stream-secret" } } },
    (error) => {
      authorizedError = error;
    }
  );
  assert.equal(authorizedError, undefined);

  let rejectedError;
  namespace.middleware(
    { handshake: { auth: { token: "wrong" } } },
    (error) => {
      rejectedError = error;
    }
  );
  assert.equal(rejectedError.message, "Unauthorized");

  const event = { event_id: "test", event_type: "website_page" };
  assert.equal(emitTrackerEvent(event), true);
  assert.deepEqual(namespace.emitted, [{ name: "tracker_event", payload: event }]);
});
