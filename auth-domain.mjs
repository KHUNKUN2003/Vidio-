import crypto from "node:crypto";

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signPart(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function parseJsonPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function signJwt(payload, secret, { expiresInSeconds = 60 * 60 * 8 } = {}) {
  if (!secret) {
    throw new Error("JWT secret is required");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const unsignedToken = `${encodeJson(header)}.${encodeJson(body)}`;
  return `${unsignedToken}.${signPart(unsignedToken, secret)}`;
}

export function verifyJwt(token, secret) {
  if (!secret) return null;

  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;

    const [headerPart, payloadPart, signature] = parts;
    const header = parseJsonPart(headerPart);
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const unsignedToken = `${headerPart}.${payloadPart}`;
    const expectedSignature = signPart(unsignedToken, secret);
    const received = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return null;
    }

    const payload = parseJsonPart(payloadPart);
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
