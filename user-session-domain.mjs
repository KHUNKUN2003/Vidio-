export const SESSION_TTL_SECONDS = 60 * 60 * 8;

export function getUserSessionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
}

export function hasActiveUserSession(row, now = new Date()) {
  if (!row?.expires_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}

export function buildUserSessionPayload(phone, sessionId) {
  return {
    role: "user",
    sub: phone,
    phone,
    sessionId,
  };
}
