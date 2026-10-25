// The parsing half of the audit gate, kept apart so a test can call it. It fails closed: any
// report that is not the npm audit version 2 shape is an error, never "no advisories".

/** The advisory ids (GHSA ...) of a `npm audit --json` report. Throws for anything unexpected. */
export function advisoryIds(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("npm audit gave no output");
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error("npm audit gave output that is not JSON");
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new Error("npm audit gave a report that is not an object");
  }
  if ("error" in report) throw new Error("npm audit reported an error");
  if (report.auditReportVersion !== 2) throw new Error("npm audit gave an unknown report version");
  const { vulnerabilities } = report;
  if (typeof vulnerabilities !== "object" || vulnerabilities === null || Array.isArray(vulnerabilities)) {
    throw new Error("npm audit gave a report without a vulnerabilities object");
  }
  const found = new Set();
  for (const vulnerability of Object.values(vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "object" && via !== null) found.add(String(via.url).split("/").pop());
    }
  }
  return found;
}
