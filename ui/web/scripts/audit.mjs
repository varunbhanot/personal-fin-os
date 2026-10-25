// The audit gate: npm audit --omit=dev fails on any advisory that audit-allow.json does not
// name, and on any allowed advisory past its end date. Each entry has a reason.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { advisoryIds } from "./audit-lib.mjs";

const allowed = JSON.parse(readFileSync(new URL("../audit-allow.json", import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);
let report;
try {
  report = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
} catch (error) {
  report = error.stdout; // npm audit exits 1 when it finds anything; advisoryIds checks the text
}
let found;
try {
  found = advisoryIds(report);
} catch (error) {
  console.error(`npm audit: ${error.message}`);
  process.exit(1);
}
const problems = [];
for (const id of found) {
  const entry = allowed.find((a) => a.id === id);
  if (!entry) problems.push(`${id} is not in audit-allow.json`);
  else if (entry.until < today) problems.push(`${id} was allowed until ${entry.until}`);
}
for (const entry of allowed) {
  if (!entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.until ?? "")) {
    problems.push(`${entry.id} needs a reason and an end date`);
  }
}
if (problems.length) {
  console.error(`npm audit: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`npm audit: ${found.size ? [...found].join(", ") + " allowed" : "no advisories"}`);
