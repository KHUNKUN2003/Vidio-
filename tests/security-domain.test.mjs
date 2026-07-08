import assert from "node:assert/strict";
import {
  createMemoryRateLimiter,
  hashPassword,
  isTrustedOrigin,
  verifyAdminCredential,
  verifyPassword,
} from "../security-domain.mjs";

const passwordHash = hashPassword("@admin_123", { salt: "fixed-test-salt" });
assert.equal(verifyPassword("@admin_123", passwordHash), true);
assert.equal(verifyPassword("wrong", passwordHash), false);
assert.equal(verifyPassword("@admin_123", "not-a-hash"), false);
assert.equal(verifyAdminCredential("admin", "@admin_123", { passwordHash }), true);
assert.equal(verifyAdminCredential("admin", "wrong", { passwordHash }), false);
assert.equal(verifyAdminCredential("user", "@admin_123", { passwordHash }), false);

let currentTime = 1000;
const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 1000, now: () => currentTime });
assert.equal(limiter.consume("login").allowed, true);
assert.equal(limiter.consume("login").allowed, true);
assert.equal(limiter.consume("login").allowed, false);
currentTime = 2001;
assert.equal(limiter.consume("login").allowed, true);

assert.equal(isTrustedOrigin("https://vidio-plus-production.up.railway.app", ["https://vidio-plus-production.up.railway.app"]), true);
assert.equal(isTrustedOrigin("https://evil.example", ["https://vidio-plus-production.up.railway.app"]), false);
assert.equal(isTrustedOrigin("", ["https://vidio-plus-production.up.railway.app"]), true);

console.log("security-domain tests passed");
