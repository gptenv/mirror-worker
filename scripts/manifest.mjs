import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {encoding:"utf8"}).trim().split("\n").filter(p => p !== "SHA256-MANIFEST.json" && existsSync(p)).sort();
const content = JSON.stringify(Object.fromEntries(paths.map(p => [p, createHash("sha256").update(readFileSync(p)).digest("hex")])), null, 2) + "\n";
if (process.argv.includes("--check")) {
  const existing = readFileSync("SHA256-MANIFEST.json", "utf8");
  if (existing !== content) {
    const existingObj = JSON.parse(existing);
    const newObj = JSON.parse(content);
    const allKeys = new Set([...Object.keys(existingObj), ...Object.keys(newObj)]);
    const diffs = [];
    for (const key of [...allKeys].sort()) {
      if (existingObj[key] !== newObj[key]) {
        diffs.push(`${key}: ${existingObj[key] || "(missing)"} -> ${newObj[key] || "(removed)"}`);
      }
    }
    throw new Error(`Manifest is stale; run npm run manifest\nDifferences:\n${diffs.join("\n")}`);
  }
} else {
  writeFileSync("SHA256-MANIFEST.json", content);
}
