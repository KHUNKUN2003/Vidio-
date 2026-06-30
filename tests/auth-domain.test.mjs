import assert from "node:assert/strict";
import { signJwt, verifyJwt } from "../auth-domain.mjs";

const token = signJwt({ role: "admin", sub: "admin" }, "test-secret", { expiresInSeconds: 60 });
const payload = verifyJwt(token, "test-secret");

assert.equal(payload.role, "admin");
assert.equal(payload.sub, "admin");
assert.equal(typeof payload.iat, "number");
assert.equal(typeof payload.exp, "number");
assert.equal(verifyJwt(token, "wrong-secret"), null);
assert.equal(verifyJwt("not-a-token", "test-secret"), null);

const expiredToken = signJwt({ role: "user" }, "test-secret", { expiresInSeconds: -1 });
assert.equal(verifyJwt(expiredToken, "test-secret"), null);

console.log("auth-domain tests passed");
