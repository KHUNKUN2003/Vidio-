import { extractYouTubeVideoId } from "./admin-utils.mjs";

export function normalizeVideoPayload(payload) {
  const title = String(payload?.title || "").trim();
  const url = String(payload?.url || "").trim();
  const description = String(payload?.description || "").trim();
  const videoId = extractYouTubeVideoId(url);

  if (!title) return { error: "Title is required" };
  if (!videoId) return { error: "Valid YouTube URL is required" };

  return {
    title,
    url,
    videoId,
    description,
    isActive: Boolean(payload?.isActive),
  };
}

export function buildDashboardStats(videos) {
  const total = videos.length;
  const active = videos.filter((video) => Boolean(video.is_active)).length;
  return {
    total,
    active,
    inactive: total - active,
  };
}

export function normalizeVideoOrderPayload(payload) {
  const ids = Array.isArray(payload?.ids) ? payload.ids.map((id) => String(id).trim()) : [];
  if (!ids.length) return { error: "Video order is required" };
  if (ids.some((id) => !/^\d+$/.test(id))) return { error: "Video order contains invalid ids" };
  if (new Set(ids).size !== ids.length) return { error: "Video order contains duplicate ids" };
  return { ids };
}
