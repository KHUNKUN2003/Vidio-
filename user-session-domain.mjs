export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const SESSION_IDLE_SECONDS = 90;

export function getUserSessionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
}

export function hasActiveUserSession(row, now = new Date()) {
  if (!row?.expires_at) return false;
  const expiresAt = new Date(row.expires_at).getTime();
  const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).getTime() : expiresAt;
  const idleCutoff = now.getTime() - SESSION_IDLE_SECONDS * 1000;
  return expiresAt > now.getTime() && lastSeenAt > idleCutoff;
}

export function buildUserSessionPayload(phone, sessionId) {
  return {
    role: "user",
    sub: phone,
    phone,
    sessionId,
  };
}
