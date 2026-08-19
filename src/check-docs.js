import fs from "node:fs";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const prd = fs.readFileSync(new URL("../docs/prd.md", import.meta.url), "utf8");
const startMarker = "<!-- PRD:START -->\n";
const endMarker = "<!-- PRD:END -->";
const start = readme.indexOf(startMarker);
const end = readme.indexOf(endMarker, start + startMarker.length);

if (start < 0 || end < 0 || readme.indexOf(startMarker, start + startMarker.length) >= 0 || readme.indexOf(endMarker, end + endMarker.length) >= 0) {
  throw new Error("README.md must contain exactly one PRD copy bounded by the required markers");
}

const copiedPrd = readme.slice(start + startMarker.length, end);
if (copiedPrd !== prd) {
  throw new Error("README.md PRD copy differs from docs/prd.md");
}

console.log("README.md PRD copy matches docs/prd.md");
