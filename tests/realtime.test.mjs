import assert from "node:assert/strict";
import { createRealtimeHub } from "../server/realtime.js";

const hub = createRealtimeHub();
const writes = [];
const ended = [];

const response = {
  writeHead(statusCode, headers) {
    writes.push({ statusCode, headers });
  },
  write(payload) {
    writes.push(payload);
  },
  end() {
    ended.push(true);
  },
};

const request = {
  on(eventName, callback) {
    this.closeCallback = eventName === "close" ? callback : this.closeCallback;
  },
};

hub.connect(request, response);
assert.equal(hub.clientCount(), 1);
assert.equal(writes[0].statusCode, 200);
assert.equal(writes[0].headers["Content-Type"], "text/event-stream");
assert.match(writes[1], /^event: ready/m);

hub.broadcast("videos");
assert.match(writes.at(-1), /^event: message/m);
assert.match(writes.at(-1), /"type":"videos"/);

request.closeCallback();
assert.equal(hub.clientCount(), 0);
assert.equal(ended.length, 1);

hub.broadcast("playlists");
assert.equal(writes.filter((entry) => typeof entry === "string" && entry.includes('"type":"playlists"')).length, 0);

console.log("realtime tests passed");
