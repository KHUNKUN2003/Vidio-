import assert from "node:assert/strict";
import {
  buildEmbedUrl,
  generateOtp,
  extractYouTubeVideoId,
  isAdminCredential,
  isValidOtp,
  normalizePhoneNumber,
} from "../admin-utils.mjs";

assert.equal(isAdminCredential("admin", "@admin_123"), true);
assert.equal(isAdminCredential("admin", "wrong"), false);
assert.equal(isAdminCredential("user", "@admin_123"), false);

assert.equal(
  extractYouTubeVideoId("https://youtu.be/Xx_69DYLHt4?si=NxttEozzHn4FarWu"),
  "Xx_69DYLHt4",
);
assert.equal(
  extractYouTubeVideoId("https://www.youtube.com/watch?v=Xx_69DYLHt4"),
  "Xx_69DYLHt4",
);
assert.equal(
  extractYouTubeVideoId("https://www.youtube.com/embed/Xx_69DYLHt4"),
  "Xx_69DYLHt4",
);
assert.equal(extractYouTubeVideoId("not a youtube url"), null);

assert.equal(
  buildEmbedUrl("Xx_69DYLHt4", 125),
  "https://www.youtube-nocookie.com/embed/Xx_69DYLHt4?start=125&autoplay=1&rel=0&modestbranding=1&iv_load_policy=3&fs=1&playsinline=1&enablejsapi=0",
);

assert.equal(normalizePhoneNumber("081-234-5678"), "0812345678");
assert.equal(normalizePhoneNumber("+66 81 234 5678"), "+66812345678");
assert.equal(normalizePhoneNumber("12345"), null);
assert.equal(normalizePhoneNumber("abc0812345678"), null);

assert.match(generateOtp(), /^\d{6}$/);
assert.equal(isValidOtp("123456", "123456"), true);
assert.equal(isValidOtp(" 123456 ", "123456"), true);
assert.equal(isValidOtp("123456", "654321"), false);

console.log("admin-utils tests passed");
