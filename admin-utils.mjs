const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "@admin_123";

export function isAdminCredential(username, password) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

export function normalizePhoneNumber(input) {
  const value = String(input || "").trim();
  if (!/^[+\d\s-]+$/.test(value)) return null;

  const normalized = value.replace(/[\s-]/g, "");
  if (/^\+66\d{9}$/.test(normalized)) return normalized;
  if (/^0\d{9}$/.test(normalized)) return normalized;
  return null;
}

export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function isValidOtp(input, expectedOtp) {
  return String(input || "").trim() === String(expectedOtp || "");
}

export function extractYouTubeVideoId(input) {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return normalizeVideoId(url.pathname.slice(1).split("/")[0]);
    }

    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") {
        return normalizeVideoId(url.searchParams.get("v"));
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) {
        return normalizeVideoId(parts[1]);
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function buildEmbedUrl(videoId, start = 0) {
  const params = new URLSearchParams();

  if (start > 0) {
    params.set("start", String(Math.floor(start)));
    params.set("autoplay", "1");
  }

  Object.entries({
    rel: "0",
    modestbranding: "1",
    iv_load_policy: "3",
    fs: "1",
    playsinline: "1",
    enablejsapi: "0",
  }).forEach(([key, value]) => {
    params.set(key, value);
  });

  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

function normalizeVideoId(value) {
  if (!value || !/^[a-zA-Z0-9_-]{11}$/.test(value)) return null;
  return value;
}
