import assert from "node:assert/strict";
import {
  buildDashboardStats,
  normalizeVideoPayload,
  normalizeVideoOrderPayload,
} from "../video-domain.mjs";

const normalized = normalizeVideoPayload({
  title: "  Match review  ",
  url: "https://youtu.be/Xx_69DYLHt4?si=test",
  description: "  main clip  ",
  isActive: true,
});

assert.deepEqual(normalized, {
  title: "Match review",
  url: "https://youtu.be/Xx_69DYLHt4?si=test",
  videoId: "Xx_69DYLHt4",
  description: "main clip",
  isActive: true,
});

assert.equal(normalizeVideoPayload({ title: "", url: "https://youtu.be/Xx_69DYLHt4" }).error, "Title is required");
assert.equal(normalizeVideoPayload({ title: "Bad", url: "bad-url" }).error, "Valid YouTube URL is required");

assert.deepEqual(
  buildDashboardStats([
    { is_active: true },
    { is_active: false },
    { is_active: true },
  ]),
  { total: 3, active: 2, inactive: 1 },
);

assert.deepEqual(normalizeVideoOrderPayload({ ids: ["3", 2, "1"] }), {
  ids: ["3", "2", "1"],
});

assert.equal(normalizeVideoOrderPayload({ ids: [] }).error, "Video order is required");
assert.equal(normalizeVideoOrderPayload({ ids: ["1", "1"] }).error, "Video order contains duplicate ids");
assert.equal(normalizeVideoOrderPayload({ ids: ["abc"] }).error, "Video order contains invalid ids");

console.log("video-domain tests passed");
