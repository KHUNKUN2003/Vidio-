import assert from "node:assert/strict";
import {
  SESSION_IDLE_SECONDS,
  SESSION_TTL_SECONDS,
  buildUserSessionPayload,
  getUserSessionExpiresAt,
  hasActiveUserSession,
} from "../user-session-domain.mjs";

const now = new Date("2026-06-30T10:00:00.000Z");
const activeRow = {
  expires_at: new Date("2026-06-30T10:01:00.000Z"),
  last_seen_at: new Date("2026-06-30T09:59:30.000Z"),
};
const expiredRow = {
  expires_at: new Date("2026-06-30T09:59:59.000Z"),
  last_seen_at: new Date("2026-06-30T09:59:30.000Z"),
};
const idleRow = {
  expires_at: new Date("2026-06-30T18:00:00.000Z"),
  last_seen_at: new Date("2026-06-30T09:58:29.000Z"),
};

assert.equal(SESSION_TTL_SECONDS, 60 * 60 * 8);
assert.equal(SESSION_IDLE_SECONDS, 90);
assert.equal(hasActiveUserSession(activeRow, now), true);
assert.equal(hasActiveUserSession(expiredRow, now), false);
assert.equal(hasActiveUserSession(idleRow, now), false);
assert.equal(hasActiveUserSession(null, now), false);

const expiresAt = getUserSessionExpiresAt(now);
assert.equal(expiresAt.toISOString(), "2026-06-30T18:00:00.000Z");

assert.deepEqual(buildUserSessionPayload("0812345678", "session-123"), {
  role: "user",
  sub: "0812345678",
  phone: "0812345678",
  sessionId: "session-123",
});

console.log("user-session-domain tests passed");
