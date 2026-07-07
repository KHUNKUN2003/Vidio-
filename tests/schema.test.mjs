import assert from "node:assert/strict";
import fs from "node:fs";

const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");

assert.equal(schema.includes("INSERT INTO videos"), false);
assert.equal(schema.includes("Xx_69DYLHt4"), false);

console.log("schema tests passed");
