import fs from "node:fs";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../config.js";
import { parseLinkedInJobHtml } from "./parseJobHtml.js";

function loadSettings() {
  try {
    if (fs.existsSync(config.settingsPath)) {
      return JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
    }
  } catch {}
  return {};
}

function loadProxy() {
  return loadSettings().proxy || null;
}

/**
 * Low-level HTTPS GET with redirect following and optional proxy agent.
 */
function httpGet(urlStr, headers, agent, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers, agent }, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        maxRedirects > 0
      ) {
        const next = new URL(res.headers.location, urlStr).toString();
        res.resume();
        resolve(httpGet(next, headers, agent, maxRedirects - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract numeric job ID from a LinkedIn job URL.
 */
function extractJobId(url) {
  const m = url.match(/\/jobs\/(?:view|search)\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Fetch a LinkedIn job page.
 *
 * Strategy:
 *  1. Normalize URL → public canonical form (no auth tokens, no /comm/)
 *  2. Plain HTTPS GET — LinkedIn public pages are SSR'd, no browser needed
 *  3. Parse with parseLinkedInJobHtml
 *  4. If title + description both empty, fall back to Voyager internal API
 */
export async function fetchLinkedInJobHtml(url) {
  const jobId = extractJobId(url);
  if (!jobId) throw new Error(`Cannot extract job ID from URL: ${url}`);

  const publicUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
  const proxy = loadProxy();
  const agent = proxy
    ? (() => {
        const u = new URL(proxy.server);
        if (proxy.username) u.username = proxy.username;
        if (proxy.password) u.password = proxy.password;
        return new HttpsProxyAgent(u.toString());
      })()
    : undefined;

  // ── Step 1: plain public HTTP fetch ───────────────────────────────────────
  try {
    console.log(`[linkedin] Fetching public URL: ${publicUrl}`);
    const publicHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
    };
    const { statusCode, body } = await httpGet(publicUrl, publicHeaders, agent);
    console.log(`[linkedin] HTTP ${statusCode} for job ${jobId} (${publicUrl})`);
    if (statusCode === 200) {
      const parsed = parseLinkedInJobHtml(body, publicUrl);
      if (parsed.title || parsed.description) {
        console.log(`[linkedin] Public HTTP fetch succeeded for job ${jobId}`);
        return parsed;
      }
      console.log(`[linkedin] Public HTTP fetch returned empty fields for job ${jobId} — falling back to Voyager`);
    } else {
      console.log(`[linkedin] Public HTTP fetch returned HTTP ${statusCode} for job ${jobId} — falling back to Voyager`);
    }
  } catch (err) {
    console.log(`[linkedin] Public HTTP fetch failed for job ${jobId}: ${err.message} — falling back to Voyager`);
  }

  // ── Step 2: Voyager API fallback ──────────────────────────────────────────
  let cookieHeader = '';
  let csrfToken = '';
  try {
    if (fs.existsSync(config.sessionPath)) {
      const session = JSON.parse(fs.readFileSync(config.sessionPath, 'utf8'));
      const cookies = Array.isArray(session.cookies) ? session.cookies : [];
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const jsession = cookies.find((c) => c.name === 'JSESSIONID');
      csrfToken = (jsession?.value || '').replace(/^"|"$/g, '');
    }
  } catch {}

  const apiUrl = `https://www.linkedin.com/voyager/api/jobs/jobPostings/${jobId}` +
    `?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
    'csrf-token': csrfToken,
    'Cookie': cookieHeader,
  };

  const { statusCode, body } = await httpGet(apiUrl, headers, agent);
  console.log(`[linkedin] Voyager API HTTP ${statusCode} for job ${jobId}`);

  if (statusCode !== 200) {
    throw new Error(`LinkedIn Voyager API returned HTTP ${statusCode} for job ${jobId}`);
  }

  const json = JSON.parse(body);
  const d = json.data || json;

  let company = '';
  const companyUrn = d.companyDetails?.company || d.companyDetails?.['*companyResolutionResult'];
  if (companyUrn && Array.isArray(json.included)) {
    const match = json.included.find((e) => e.entityUrn === companyUrn || e['$id'] === companyUrn);
    company = match?.name || '';
  }

  const location = d.formattedLocation || '';
  const description = d.description?.text || '';

  console.log(`[linkedin] Voyager API fallback succeeded for job ${jobId}`);
  return { url: publicUrl, title: d.title || '', company, location, description };
}
