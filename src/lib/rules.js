import fs from "node:fs";
import { config } from "../config.js";

function includesNormalized(text, candidate) {
  return text.toLowerCase().includes(candidate.toLowerCase());
}

export function loadRules() {
  const raw = fs.readFileSync(config.rulesPath, "utf8");
  return JSON.parse(raw);
}

export function evaluateVacancy(details, rules) {
  const haystack = [
    details.title,
    details.company,
    details.location,
    details.description
  ]
    .filter(Boolean)
    .join("\n");

  const mustIncludeHits = (rules.mustInclude || []).filter((item) =>
    includesNormalized(haystack, item)
  );
  const mustExcludeHits = (rules.mustExclude || []).filter((item) =>
    includesNormalized(haystack, item)
  );
  const locationMatch =
    !rules.preferredLocations?.length ||
    rules.preferredLocations.some((item) =>
      includesNormalized(details.location || "", item)
    );

  const includeRules = rules.mustInclude || [];
  const passedIncludes =
    includeRules.length === 0 || mustIncludeHits.length === includeRules.length;
  const passed = mustExcludeHits.length === 0 && passedIncludes && locationMatch;

  return {
    passed,
    mustIncludeHits,
    mustExcludeHits,
    locationMatch,
    notes: rules.notes || ""
  };
}
