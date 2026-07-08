import crypto from "node:crypto";

export const ADMIN_PASSWORD_HASH_PREFIX = "scrypt:";

export function hashPassword(password, { salt = crypto.randomBytes(16).toString("base64url") } = {}) {
  const key = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return `${ADMIN_PASSWORD_HASH_PREFIX}${salt}:${key}`;
}

export function verifyPassword(password, passwordHash) {
  const value = String(passwordHash || "");
  if (!value.startsWith(ADMIN_PASSWORD_HASH_PREFIX)) return false;

  const [, salt, storedKey] = value.split(":");
  if (!salt || !storedKey) return false;

  const key = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  const received = Buffer.from(key);
  const expected = Buffer.from(storedKey);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function verifyAdminCredential(username, password, options = {}) {
  const adminUsername = options.username || process.env.ADMIN_USERNAME || "admin";
  const adminPasswordHash = options.passwordHash || process.env.ADMIN_PASSWORD_HASH || "";
  const adminPassword = options.password || process.env.ADMIN_PASSWORD || "@admin_123";

  if (username !== adminUsername) return false;
  if (adminPasswordHash) return verifyPassword(password, adminPasswordHash);
  return password === adminPassword;
}

export function createMemoryRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();

  return {
    consume(key) {
      const normalizedKey = String(key || "anonymous");
      const currentTime = now();
      const current = hits.get(normalizedKey);

      if (!current || current.resetAt <= currentTime) {
        hits.set(normalizedKey, { count: 1, resetAt: currentTime + windowMs });
        return { allowed: true, limit, remaining: Math.max(limit - 1, 0), resetAt: currentTime + windowMs };
      }

      if (current.count >= limit) {
        return { allowed: false, limit, remaining: 0, resetAt: current.resetAt };
      }

      current.count += 1;
      return { allowed: true, limit, remaining: Math.max(limit - current.count, 0), resetAt: current.resetAt };
    },
    clear() {
      hits.clear();
    },
  };
}

export function isTrustedOrigin(origin, allowedOrigins) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}
