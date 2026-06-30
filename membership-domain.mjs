export const MEMBERSHIP_STATUSES = ["pending", "approved", "rejected"];

export function normalizeLineMembershipPayload(input) {
  const lineName = String(input?.lineName || "").trim();
  const lineUserId = String(input?.lineUserId || lineName).trim();

  if (!lineName) {
    return { error: "กรุณากรอกชื่อ LINE" };
  }

  if (lineName.length > 80) {
    return { error: "ชื่อ LINE ต้องไม่เกิน 80 ตัวอักษร" };
  }

  return {
    lineName,
    lineUserId: lineUserId || lineName,
  };
}

export function isMembershipStatus(value) {
  return MEMBERSHIP_STATUSES.includes(value);
}

export function canWatchWithMembership(status) {
  return status === "approved";
}

export function buildLineMembershipSessionPayload(request, sessionId = "") {
  return {
    role: "user",
    sub: `line:${request.line_user_id}`,
    provider: "line",
    lineUserId: request.line_user_id,
    lineName: request.line_name,
    sessionId,
  };
}
