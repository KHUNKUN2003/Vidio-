import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { signJwt, verifyJwt } from "../auth-domain.mjs";
import { createMemoryRateLimiter, isTrustedOrigin, verifyAdminCredential } from "../security-domain.mjs";
import {
  buildLineMembershipSessionPayload,
  canWatchWithMembership,
  isMembershipStatus,
  normalizeLineMembershipPayload,
} from "../membership-domain.mjs";
import {
  SESSION_IDLE_SECONDS,
  SESSION_TTL_SECONDS,
  getUserSessionExpiresAt,
  hasActiveUserSession,
} from "../user-session-domain.mjs";
import { buildDashboardStats, normalizeVideoOrderPayload, normalizeVideoPayload } from "../video-domain.mjs";
import { ensureSchema, pool, requireDatabase } from "./db.js";
import { createRealtimeHub } from "./realtime.js";

export const app = express();
const port = Number(process.env.PORT || 4174);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistDir = path.resolve(__dirname, "../dist");
const clientIndexPath = path.join(clientDistDir, "index.html");
const jwtSecret = process.env.JWT_SECRET || "course-dashboard-dev-secret";
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
const defaultClientUrl = vercelUrl ? `https://${vercelUrl}` : "http://127.0.0.1:5173";
const clientUrl = process.env.CLIENT_URL || defaultClientUrl;
const lineChannelId = process.env.LINE_CHANNEL_ID || "";
const lineChannelSecret = process.env.LINE_CHANNEL_SECRET || "";
const lineCallbackUrl = process.env.LINE_CALLBACK_URL || `${clientUrl}/api/auth/line/callback`;
const lineOAuthStates = new Map();
const lineLoginResults = new Map();
const realtimeHub = createRealtimeHub();
const authCookieName = "vidio_auth";
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = [
  clientUrl,
  "https://vidio-plus-production.up.railway.app",
  "https://vidio-plus.vercel.app",
].filter(Boolean);
const adminLoginLimiter = createMemoryRateLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
const lineLoginLimiter = createMemoryRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
const adminMutationLimiter = createMemoryRateLimiter({ limit: 120, windowMs: 60 * 1000 });

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(applySecurityHeaders);
app.use(rejectUntrustedOrigin);
app.use(express.json());

function createSessionToken(payload) {
  return signJwt(payload, jwtSecret, { expiresInSeconds: SESSION_TTL_SECONDS });
}

function applySecurityHeaders(_request, response, next) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://vidio-plus-production.up.railway.app https://vidio-plus.vercel.app",
      "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  next();
}

function rejectUntrustedOrigin(request, response, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    next();
    return;
  }

  const requestOrigin = `${request.protocol}://${request.get("host")}`;
  const origins = [...new Set([...allowedOrigins, requestOrigin])];
  if (!isTrustedOrigin(request.get("origin") || "", origins)) {
    response.status(403).json({ error: "Untrusted origin" });
    return;
  }

  next();
}

function parseCookies(cookieHeader) {
  try {
    return Object.fromEntries(
      String(cookieHeader || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const separatorIndex = part.indexOf("=");
          if (separatorIndex === -1) return [part, ""];
          return [
            decodeURIComponent(part.slice(0, separatorIndex)),
            decodeURIComponent(part.slice(separatorIndex + 1)),
          ];
        }),
    );
  } catch {
    return {};
  }
}

function getAuthToken(request) {
  const header = request.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return parseCookies(request.headers.cookie)[authCookieName] || "";
}

function setAuthCookie(response, token) {
  const secure = isProduction ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${authCookieName}=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
  );
}

function clearAuthCookie(response) {
  const secure = isProduction ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${authCookieName}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function clientIp(request) {
  return request.ip || request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "anonymous";
}

function rateLimit(limiter, keyFactory) {
  return (request, response, next) => {
    const key = keyFactory(request);
    const result = limiter.consume(key);
    response.setHeader("RateLimit-Limit", String(result.limit));
    response.setHeader("RateLimit-Remaining", String(result.remaining));
    response.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      response.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}

function isLineLoginConfigured() {
  return Boolean(lineChannelId && lineChannelSecret && lineCallbackUrl);
}

function buildClientRedirect(params) {
  const url = new URL(clientUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function pruneExpiredMapEntries(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

async function pruneInactiveUserSessions() {
  await pool.query(
    `DELETE FROM user_sessions
     WHERE expires_at <= NOW()
        OR last_seen_at <= NOW() - ($1::int * INTERVAL '1 second')`,
    [SESSION_IDLE_SECONDS],
  );
}

async function buildLineAuthResult(membershipRequest, { enforceSingleSession = false, currentSessionId = "" } = {}) {
  const canWatch = canWatchWithMembership(membershipRequest.status);
  let sessionId = currentSessionId;

  if (canWatch) {
    await pruneInactiveUserSessions();
    const activeSession = await pool.query(
      `SELECT session_id, expires_at, last_seen_at
       FROM user_sessions
       WHERE identity_type = 'line'
         AND identity_value = $1`,
      [membershipRequest.line_user_id],
    );
    const activeSessionRow = activeSession.rows[0];
    const isExistingSessionActive = hasActiveUserSession(activeSessionRow);

    if (
      enforceSingleSession
      && isExistingSessionActive
      && activeSessionRow.session_id !== currentSessionId
    ) {
      return {
        error: "บัญชีนี้กำลังใช้งานอยู่ในอุปกรณ์อื่น",
        code: "line_session_active",
        statusCode: 409,
      };
    }

    sessionId = isExistingSessionActive ? activeSessionRow.session_id : currentSessionId || crypto.randomUUID();
    const expiresAt = getUserSessionExpiresAt();
    await pool.query(
      `INSERT INTO user_sessions (phone, identity_type, identity_value, session_id, expires_at)
       VALUES (NULL, 'line', $1, $2, $3)
       ON CONFLICT (identity_type, identity_value)
       DO UPDATE SET session_id = EXCLUDED.session_id,
                     expires_at = EXCLUDED.expires_at,
                     last_seen_at = NOW(),
                     created_at = NOW()`,
      [membershipRequest.line_user_id, sessionId, expiresAt],
    );
  }

  return {
    request: membershipRequest,
    canWatch,
    token: canWatch ? createSessionToken(buildLineMembershipSessionPayload(membershipRequest, sessionId)) : null,
    user: canWatch
      ? { role: "user", provider: "line", lineName: membershipRequest.line_name, lineUserId: membershipRequest.line_user_id }
      : null,
  };
}

async function upsertLineMembershipRequest({ lineUserId, lineName }) {
  const result = await pool.query(
    `INSERT INTO membership_requests (line_user_id, line_name, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (line_user_id)
     DO UPDATE SET line_name = EXCLUDED.line_name,
                   status = CASE
                     WHEN membership_requests.status = 'approved' THEN 'approved'
                     ELSE 'pending'
                   END,
                   reviewed_at = CASE
                     WHEN membership_requests.status = 'approved' THEN membership_requests.reviewed_at
                     ELSE NULL
                   END,
                   updated_at = NOW()
     RETURNING id, line_user_id, line_name, status, reviewed_at, created_at, updated_at`,
    [lineUserId, lineName],
  );

  return result.rows[0];
}

function requireAuth(role) {
  return (request, response, next) => {
    const token = getAuthToken(request);
    const payload = verifyJwt(token, jwtSecret);

    if (!payload || (role && payload.role !== role)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    request.user = payload;
    next();
  };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, database: Boolean(pool) });
});

app.get("/api/events", requireDatabase, (request, response) => {
  realtimeHub.connect(request, response);
});

app.use("/api/videos", requireDatabase);
app.use("/api/dashboard", requireDatabase);
app.use("/api/memberships", requireDatabase);
app.use("/api/playlists", requireDatabase);
app.use(
  ["/api/videos", "/api/memberships", "/api/playlists"],
  (request, response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      next();
      return;
    }
    rateLimit(adminMutationLimiter, (innerRequest) => `${clientIp(innerRequest)}:admin-mutation:${innerRequest.path}`)(
      request,
      response,
      next,
    );
  },
);

function normalizePlaylistPayload(input) {
  const title = String(input?.title || "").trim();
  const description = String(input?.description || "").trim();
  const videoIds = Array.isArray(input?.videoIds)
    ? input.videoIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id))
    : [];

  if (!title) return { error: "Playlist title is required" };
  if (title.length > 120) return { error: "Playlist title must be 120 characters or fewer" };

  return {
    title,
    description,
    videoIds: [...new Set(videoIds)],
  };
}

async function fetchPlaylists() {
  const result = await pool.query(
    `SELECT
       playlists.id,
       playlists.title,
       playlists.description,
       playlists.sort_order,
       playlists.created_at,
       playlists.updated_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id', videos.id,
             'title', videos.title,
             'youtube_url', videos.youtube_url,
             'youtube_video_id', videos.youtube_video_id,
             'description', videos.description,
             'is_active', videos.is_active,
             'sort_order', playlist_videos.sort_order,
             'created_at', videos.created_at,
             'updated_at', videos.updated_at
           )
           ORDER BY playlist_videos.sort_order ASC, videos.sort_order ASC, videos.created_at DESC, videos.id DESC
         ) FILTER (WHERE videos.id IS NOT NULL),
         '[]'::json
       ) AS videos
     FROM playlists
     LEFT JOIN playlist_videos ON playlist_videos.playlist_id = playlists.id
     LEFT JOIN videos ON videos.id = playlist_videos.video_id
     GROUP BY playlists.id
     ORDER BY playlists.sort_order ASC, playlists.created_at DESC, playlists.id DESC`,
  );

  return result.rows;
}

async function replacePlaylistVideos(client, playlistId, videoIds) {
  await client.query("DELETE FROM playlist_videos WHERE playlist_id = $1", [playlistId]);
  await Promise.all(
    videoIds.map((videoId, index) => (
      client.query(
        `INSERT INTO playlist_videos (playlist_id, video_id, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (playlist_id, video_id)
         DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [playlistId, videoId, index],
      )
    )),
  );
}

app.post("/api/auth/admin/login", rateLimit(adminLoginLimiter, (request) => `${clientIp(request)}:admin:${request.body?.username || ""}`), (request, response) => {
  const username = String(request.body?.username || "");
  const password = String(request.body?.password || "");

  if (!verifyAdminCredential(username, password)) {
    response.status(401).json({ error: "Username or password is incorrect" });
    return;
  }

  const token = createSessionToken({ role: "admin", sub: "admin" });
  setAuthCookie(response, token);
  response.json({
    token,
    user: { role: "admin", username: "admin" },
  });
});

app.post("/api/auth/heartbeat", requireDatabase, requireAuth("user"), async (request, response, next) => {
  try {
    await pruneInactiveUserSessions();

    if (request.user.provider !== "line" || !request.user.lineUserId || !request.user.sessionId) {
      response.status(401).json({ error: "Session is no longer active" });
      return;
    }

    const result = await pool.query(
      `UPDATE user_sessions
       SET last_seen_at = NOW(),
           expires_at = $3
       WHERE identity_type = 'line'
         AND identity_value = $1
         AND session_id = $2`,
      [request.user.lineUserId, request.user.sessionId, getUserSessionExpiresAt()],
    );

    if (!result.rowCount) {
      response.status(401).json({ error: "Session is no longer active" });
      return;
    }

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireAuth(), async (request, response, next) => {
  try {
    if (pool && request.user.role === "user" && request.user.provider === "line" && request.user.lineUserId && request.user.sessionId) {
      await pool.query(
        "DELETE FROM user_sessions WHERE identity_type = 'line' AND identity_value = $1 AND session_id = $2",
        [request.user.lineUserId, request.user.sessionId],
      );
    }
    clearAuthCookie(response);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/line/request", rateLimit(lineLoginLimiter, (request) => `${clientIp(request)}:line-request:${request.body?.lineUserId || ""}`), requireDatabase, async (request, response, next) => {
  const payload = normalizeLineMembershipPayload(request.body);
  if (payload.error) {
    response.status(400).json({ error: payload.error });
    return;
  }

  try {
    const membershipRequest = await upsertLineMembershipRequest({
      lineUserId: payload.lineUserId,
      lineName: payload.lineName,
    });
    const authResult = await buildLineAuthResult(membershipRequest, { enforceSingleSession: true });
    realtimeHub.broadcast("memberships");
    if (authResult.token) setAuthCookie(response, authResult.token);
    response.status(authResult.statusCode || 201).json(authResult);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/line/start", rateLimit(lineLoginLimiter, (request) => `${clientIp(request)}:line-start`), requireDatabase, (_request, response) => {
  if (!isLineLoginConfigured()) {
    response.redirect(buildClientRedirect({ line_error: "line_config_missing" }));
    return;
  }

  pruneExpiredMapEntries(lineOAuthStates);
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  lineOAuthStates.set(state, { nonce, expiresAt: Date.now() + 10 * 60 * 1000 });

  const authorizeUrl = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", lineChannelId);
  authorizeUrl.searchParams.set("redirect_uri", lineCallbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "profile openid");
  authorizeUrl.searchParams.set("nonce", nonce);

  response.redirect(authorizeUrl.toString());
});

app.get("/api/auth/line/callback", requireDatabase, async (request, response, next) => {
  const code = String(request.query.code || "");
  const state = String(request.query.state || "");
  const lineError = String(request.query.error || "");

  if (lineError) {
    response.redirect(buildClientRedirect({ line_error: "line_cancelled" }));
    return;
  }

  pruneExpiredMapEntries(lineOAuthStates);
  const savedState = lineOAuthStates.get(state);
  lineOAuthStates.delete(state);

  if (!code || !savedState) {
    response.redirect(buildClientRedirect({ line_error: "line_state_invalid" }));
    return;
  }

  try {
    const tokenResponse = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: lineCallbackUrl,
        client_id: lineChannelId,
        client_secret: lineChannelSecret,
      }),
    });

    const tokenData = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok || !tokenData?.access_token) {
      response.redirect(buildClientRedirect({ line_error: "line_token_failed" }));
      return;
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileResponse.json().catch(() => null);
    if (!profileResponse.ok || !profile?.userId) {
      response.redirect(buildClientRedirect({ line_error: "line_profile_failed" }));
      return;
    }

    const membershipRequest = await upsertLineMembershipRequest({
      lineUserId: profile.userId,
      lineName: profile.displayName || profile.userId,
    });
    const authResult = await buildLineAuthResult(membershipRequest, { enforceSingleSession: true });
    const resultCode = crypto.randomUUID();
    lineLoginResults.set(resultCode, {
      data: authResult,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    realtimeHub.broadcast("memberships");
    response.redirect(buildClientRedirect({ line_result: resultCode }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/line/session", (request, response) => {
  const resultCode = String(request.query.code || "");
  pruneExpiredMapEntries(lineLoginResults);

  const result = lineLoginResults.get(resultCode);
  if (!result) {
    response.status(404).json({ error: "LINE login result expired" });
    return;
  }

  lineLoginResults.delete(resultCode);
  if (result.data.token) setAuthCookie(response, result.data.token);
  response.status(result.data.statusCode || 200).json(result.data);
});

app.get("/api/auth/line/status", requireDatabase, async (request, response, next) => {
  const lineUserId = String(request.query.lineUserId || "").trim();
  if (!lineUserId) {
    response.status(400).json({ error: "Missing LINE user id" });
    return;
  }

  try {
    const currentUser = verifyJwt(getAuthToken(request), jwtSecret);
    const currentSessionId =
      currentUser?.role === "user" && currentUser.provider === "line" && currentUser.lineUserId === lineUserId
        ? currentUser.sessionId || ""
        : "";
    const result = await pool.query(
      `SELECT id, line_user_id, line_name, status, reviewed_at, created_at, updated_at
       FROM membership_requests
       WHERE line_user_id = $1`,
      [lineUserId],
    );

    if (!result.rowCount) {
      response.status(404).json({ error: "Membership request not found" });
      return;
    }

    const membershipRequest = result.rows[0];
    const authResult = await buildLineAuthResult(membershipRequest, {
      enforceSingleSession: true,
      currentSessionId,
    });
    if (authResult.token) setAuthCookie(response, authResult.token);
    response.status(authResult.statusCode || 200).json(authResult);
  } catch (error) {
    next(error);
  }
});

app.get("/api/memberships", requireAuth("admin"), async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, line_user_id, line_name, status, reviewed_at, created_at, updated_at
       FROM membership_requests
       ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         created_at DESC,
         id DESC`,
    );
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/memberships/:id/status", requireAuth("admin"), async (request, response, next) => {
  const status = String(request.body?.status || "");
  if (!["approved", "rejected"].includes(status) || !isMembershipStatus(status)) {
    response.status(400).json({ error: "Invalid membership status" });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE membership_requests
       SET status = $1,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, line_user_id, line_name, status, reviewed_at, created_at, updated_at`,
      [status, request.params.id],
    );

    if (!result.rowCount) {
      response.status(404).json({ error: "Membership request not found" });
      return;
    }

    if (status === "rejected") {
      await pool.query(
        "DELETE FROM user_sessions WHERE identity_type = 'line' AND identity_value = $1",
        [result.rows[0].line_user_id],
      );
      realtimeHub.broadcast("sessions");
    }

    realtimeHub.broadcast("memberships");
    response.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/memberships/:id", requireAuth("admin"), async (request, response, next) => {
  try {
    const result = await pool.query(
      "DELETE FROM membership_requests WHERE id = $1 RETURNING line_user_id",
      [request.params.id],
    );
    if (!result.rowCount) {
      response.status(404).json({ error: "Membership request not found" });
      return;
    }
    await pool.query(
      "DELETE FROM user_sessions WHERE identity_type = 'line' AND identity_value = $1",
      [result.rows[0].line_user_id],
    );
    realtimeHub.broadcast("memberships");
    realtimeHub.broadcast("sessions");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/playlists", async (_request, response, next) => {
  try {
    response.json(await fetchPlaylists());
  } catch (error) {
    next(error);
  }
});

app.post("/api/playlists", requireAuth("admin"), async (request, response, next) => {
  const payload = normalizePlaylistPayload(request.body);
  if (payload.error) {
    response.status(400).json({ error: payload.error });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sortOrderResult = await client.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM playlists");
    const playlistResult = await client.query(
      `INSERT INTO playlists (title, description, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [payload.title, payload.description, sortOrderResult.rows[0].next_sort_order],
    );
    await replacePlaylistVideos(client, playlistResult.rows[0].id, payload.videoIds);
    await client.query("COMMIT");

    realtimeHub.broadcast("playlists");
    response.status(201).json(await fetchPlaylists());
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.put("/api/playlists/:id", requireAuth("admin"), async (request, response, next) => {
  const payload = normalizePlaylistPayload(request.body);
  if (payload.error) {
    response.status(400).json({ error: payload.error });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const playlistResult = await client.query(
      `UPDATE playlists
       SET title = $1,
           description = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id`,
      [payload.title, payload.description, request.params.id],
    );

    if (!playlistResult.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Playlist not found" });
      return;
    }

    await replacePlaylistVideos(client, request.params.id, payload.videoIds);
    await client.query("COMMIT");

    realtimeHub.broadcast("playlists");
    response.json(await fetchPlaylists());
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.delete("/api/playlists/:id", requireAuth("admin"), async (request, response, next) => {
  try {
    const result = await pool.query("DELETE FROM playlists WHERE id = $1", [request.params.id]);
    if (!result.rowCount) {
      response.status(404).json({ error: "Playlist not found" });
      return;
    }
    realtimeHub.broadcast("playlists");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", async (_request, response, next) => {
  try {
    const result = await pool.query("SELECT is_active FROM videos");
    response.json(buildDashboardStats(result.rows));
  } catch (error) {
    next(error);
  }
});

app.get("/api/videos", async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, youtube_url, youtube_video_id, description, is_active, sort_order, created_at, updated_at
       FROM videos
       ORDER BY sort_order ASC, created_at DESC, id DESC`,
    );
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post("/api/videos", requireAuth("admin"), async (request, response, next) => {
  try {
    const payload = normalizeVideoPayload(request.body);
    if (payload.error) {
      response.status(400).json({ error: payload.error });
      return;
    }

    const sortOrderResult = await pool.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM videos");
    const result = await pool.query(
      `INSERT INTO videos (title, youtube_url, youtube_video_id, description, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, youtube_url, youtube_video_id, description, is_active, sort_order, created_at, updated_at`,
      [payload.title, payload.url, payload.videoId, payload.description, payload.isActive, sortOrderResult.rows[0].next_sort_order],
    );
    realtimeHub.broadcast("videos");
    realtimeHub.broadcast("playlists");
    response.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({ error: "This YouTube video already exists" });
      return;
    }
    next(error);
  }
});

app.patch("/api/videos/order", requireAuth("admin"), async (request, response, next) => {
  const payload = normalizeVideoOrderPayload(request.body);
  if (payload.error) {
    response.status(400).json({ error: payload.error });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM videos WHERE id = ANY($1::bigint[])", [payload.ids]);
    if (existing.rowCount !== payload.ids.length) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: "Video order contains unknown ids" });
      return;
    }

    await Promise.all(
      payload.ids.map((id, index) => (
        client.query("UPDATE videos SET sort_order = $1, updated_at = NOW() WHERE id = $2", [index, id])
      )),
    );
    await client.query("COMMIT");

    const result = await pool.query(
      `SELECT id, title, youtube_url, youtube_video_id, description, is_active, sort_order, created_at, updated_at
       FROM videos
       ORDER BY sort_order ASC, created_at DESC, id DESC`,
    );
    realtimeHub.broadcast("videos");
    realtimeHub.broadcast("playlists");
    response.json(result.rows);
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.put("/api/videos/:id", requireAuth("admin"), async (request, response, next) => {
  try {
    const payload = normalizeVideoPayload(request.body);
    if (payload.error) {
      response.status(400).json({ error: payload.error });
      return;
    }

    const result = await pool.query(
      `UPDATE videos
       SET title = $1,
           youtube_url = $2,
           youtube_video_id = $3,
           description = $4,
           is_active = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, title, youtube_url, youtube_video_id, description, is_active, sort_order, created_at, updated_at`,
      [payload.title, payload.url, payload.videoId, payload.description, payload.isActive, request.params.id],
    );

    if (!result.rowCount) {
      response.status(404).json({ error: "Video not found" });
      return;
    }
    realtimeHub.broadcast("videos");
    realtimeHub.broadcast("playlists");
    response.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      response.status(409).json({ error: "This YouTube video already exists" });
      return;
    }
    next(error);
  }
});

app.delete("/api/videos/:id", requireAuth("admin"), async (request, response, next) => {
  try {
    const result = await pool.query("DELETE FROM videos WHERE id = $1", [request.params.id]);
    if (!result.rowCount) {
      response.status(404).json({ error: "Video not found" });
      return;
    }
    realtimeHub.broadcast("videos");
    realtimeHub.broadcast("playlists");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

if (fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistDir));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(clientIndexPath);
  });
}

app.use((error, _request, response, _next) => {
  if (error?.status === 400 && error?.type === "entity.parse.failed") {
    response.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

export async function initializeDatabase() {
  await ensureSchema();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  initializeDatabase()
    .then(() => {
      app.listen(port, "0.0.0.0", () => {
        console.log(`Server running on http://0.0.0.0:${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to initialize database schema", error);
      process.exitCode = 1;
    });
}
