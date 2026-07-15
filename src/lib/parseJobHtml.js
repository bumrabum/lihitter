import { parse } from "node-html-parser";

/**
 * Selectors tried in order for each field.
 * Standard authenticated SPA selectors first, then unauthenticated static fallbacks.
 */
const SELECTORS = {
  title: [
    ".job-details-jobs-unified-top-card__job-title h1",
    "h1.top-card-layout__title",
    "h1"
  ],
  company: [
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    "a.topcard__org-name-link",
    ".topcard__org-name-link",
    "a[data-tracking-control-name='public_jobs_topcard-org-name']"
  ],
  location: [
    ".job-details-jobs-unified-top-card__primary-description-container",
    ".topcard__flavor--bullet",
    "span.topcard__flavor--bullet",
    ".job-details-jobs-unified-top-card__bullet"
  ],
  description: [
    ".jobs-description-content__text",
    ".jobs-description",
    ".show-more-less-html__markup",
    ".description__text",
    "[data-testid='expandable-text-box']"
  ]
};

/**
 * Try each selector in order, return the trimmed text of the first match.
 */
function firstText(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const text = el.text?.trim() || el.innerText?.trim() || "";
      if (text) return text;
    }
  }
  return "";
}

/**
 * Parse title and company from the <title> tag.
 * LinkedIn's <title> is always: "Job Title | Company Name | LinkedIn"
 */
function parseTitleTag(root) {
  const titleEl = root.querySelector("title");
  const raw = titleEl?.text?.trim() || "";
  // Format: "Job Title | Company | LinkedIn"
  const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === "linkedin") {
    return {
      title: parts[0],
      company: parts[1]
    };
  }
  if (parts.length >= 1) {
    return { title: parts[0], company: "" };
  }
  return { title: "", company: "" };
}

/**
 * Extract location from the dot-separated metadata line.
 * LinkedIn uses spans separated by · e.g. "EMEA · 4 days ago · Over 100 applicants"
 * We find the first span whose text looks like a location (not a time-ago or applicant count).
 */
function extractLocation(root) {
  // Try standard selectors first
  for (const sel of SELECTORS.location) {
    const el = root.querySelector(sel);
    if (el) {
      const text = el.text?.trim() || "";
      if (text) return cleanLocation(text);
    }
  }

  // Fallback: find a <p> or <span> containing · with location-like text
  // We look for spans that appear before the first · separator
  const allSpans = root.querySelectorAll("span");
  for (const span of allSpans) {
    const text = span.text?.trim() || "";
    // Likely a location: 2-60 chars, contains letters, no digit-heavy patterns
    if (
      text.length >= 2 &&
      text.length <= 60 &&
      /[A-Za-z]/.test(text) &&
      !text.includes("·") &&
      !/^\d+$/.test(text) &&
      !/\d+\s+(day|week|month|hour|minute)s?\s+ago/i.test(text) &&
      !/applicant|follower|employee|connection/i.test(text) &&
      // Parent contains a · separator (i.e. this is a metadata line)
      (span.parentNode?.text || "").includes("·")
    ) {
      return text;
    }
  }

  return "";
}

/**
 * Clean up noisy location strings.
 * e.g. "Acme Corp · 2 weeks ago · San Francisco, CA (Remote)" → "San Francisco, CA (Remote)"
 */
function cleanLocation(raw) {
  if (!raw) return "";
  const parts = raw.split(/\s*·\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return raw.trim();
  // Walk from the end, skip time-ago and applicant-count segments
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (
      /\d+\s+(day|week|month|hour|minute|second)s?\s+ago/i.test(p) ||
      /just now/i.test(p) ||
      /applicant|follower/i.test(p)
    ) {
      continue;
    }
    return p;
  }
  return parts[0];
}

/**
 * Extract job description text.
 * For the email-reminder compact view, the description lives in data-testid="expandable-text-box".
 * For the standard job detail view, it's in .jobs-description-content__text or similar.
 */
function extractDescription(root) {
  return firstText(root, SELECTORS.description);
}

/**
 * Parse a LinkedIn job page HTML string and return structured vacancy details.
 *
 * Works with:
 *  - Standard authenticated SPA job detail pages (/jobs/view/<id>)
 *  - Email-reminder compact view pages (with data-testid="expandable-text-box")
 *  - Unauthenticated static pages
 *
 * @param {string} html - Raw HTML content of a LinkedIn job page
 * @param {string} [url] - Original URL of the page (optional, for reference)
 * @returns {{ url: string, title: string, company: string, location: string, description: string }}
 */
export function parseLinkedInJobHtml(html, url = "") {
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: {
      script: false,
      noscript: false,
      style: false,
      pre: true
    }
  });

  // Try DOM selectors first, fall back to <title> tag parsing
  let title = firstText(root, SELECTORS.title);
  let company = firstText(root, SELECTORS.company);

  if (!title || !company) {
    const fromTitle = parseTitleTag(root);
    if (!title) title = fromTitle.title;
    if (!company) company = fromTitle.company;
  }

  // Company from <a href="/company/..."> link (most reliable for compact view)
  if (!company) {
    const companyLink = root.querySelector('a[href*="/company/"]');
    company = companyLink?.text?.trim() || "";
  }

  const location = extractLocation(root);
  const description = extractDescription(root);

  return { url, title, company, location, description };
}
