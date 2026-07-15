const LINK_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

function unique(values) {
  return [...new Set(values)];
}

/**
 * Normalize any LinkedIn job URL to the public canonical form.
 * Strips /comm/ prefix, query params, and auth tokens.
 * Returns null if no job ID can be extracted.
 */
export function normalizeJobUrl(url) {
  const m = url.match(/\/jobs\/(?:view|search)\/(\d+)/);
  if (!m) return null;
  return `https://www.linkedin.com/jobs/view/${m[1]}/`;
}

export function extractVacancyLinks({ subject = "", text = "", html = "" }) {
  const source = [subject, text, html].filter(Boolean).join("\n");
  const links = source.match(LINK_PATTERN) || [];

  const matched = links.filter((link) => {
    const value = link.toLowerCase();
    return value.includes("linkedin.com/jobs") || value.includes("linkedin.com/comm/jobs");
  });

  return unique(matched.map((link) => normalizeJobUrl(link)).filter(Boolean));
}
