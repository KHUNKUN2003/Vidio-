import assert from "node:assert/strict";
import { app } from "../server/index.js";

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const loginResponse = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ username: "admin", password: "@admin_123" }),
  });

  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get("set-cookie") || "", /vidio_auth=.*HttpOnly/);
  assert.equal(loginResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(loginResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);

  const blockedResponse = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ username: "admin", password: "@admin_123" }),
  });

  assert.equal(blockedResponse.status, 403);

  const blockedBeforeJsonParseResponse = await fetch(`${baseUrl}/api/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: "{not-json",
  });

  assert.equal(blockedBeforeJsonParseResponse.status, 403);
  console.log("server-security tests passed");
} finally {
  server.close();
}
