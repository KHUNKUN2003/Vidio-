import assert from "node:assert/strict";
import {
  buildLineMembershipSessionPayload,
  canWatchWithMembership,
  isMembershipStatus,
  normalizeLineMembershipPayload,
} from "../membership-domain.mjs";

assert.deepEqual(normalizeLineMembershipPayload({ lineName: "  Mint Line  " }), {
  lineName: "Mint Line",
  lineUserId: "Mint Line",
});

assert.deepEqual(normalizeLineMembershipPayload({ lineName: "Mint", lineUserId: "line-user-1" }), {
  lineName: "Mint",
  lineUserId: "line-user-1",
});

assert.equal(normalizeLineMembershipPayload({ lineName: "" }).error, "กรุณากรอกชื่อ LINE");
assert.equal(normalizeLineMembershipPayload({ lineName: "x".repeat(81) }).error, "ชื่อ LINE ต้องไม่เกิน 80 ตัวอักษร");

assert.equal(isMembershipStatus("pending"), true);
assert.equal(isMembershipStatus("approved"), true);
assert.equal(isMembershipStatus("rejected"), true);
assert.equal(isMembershipStatus("archived"), false);

assert.equal(canWatchWithMembership("approved"), true);
assert.equal(canWatchWithMembership("pending"), false);
assert.equal(canWatchWithMembership("rejected"), false);

assert.deepEqual(buildLineMembershipSessionPayload({ line_user_id: "line-1", line_name: "Mint" }), {
  role: "user",
  sub: "line:line-1",
  provider: "line",
  lineUserId: "line-1",
  lineName: "Mint",
  sessionId: "",
});

assert.deepEqual(buildLineMembershipSessionPayload({ line_user_id: "line-1", line_name: "Mint" }, "session-123"), {
  role: "user",
  sub: "line:line-1",
  provider: "line",
  lineUserId: "line-1",
  lineName: "Mint",
  sessionId: "session-123",
});

console.log("membership-domain tests passed");
