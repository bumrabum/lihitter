import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";

/**
 * Convert a Gmail-style query string to an imapflow search criteria object.
 * Supports: newer_than:<n>d, from:<sender>, and free-text subject keywords.
 * The label: part is handled separately (folder selection).
 */
function queryToImap(query) {
  const criteria = {};

  // newer_than:Nd or newer_than:Nh  →  since: <date> (IMAP SINCE is day-granularity only)
  const newerMatch = query.match(/newer_than:(\d+)(d|h)/i);
  if (newerMatch) {
    const amount = Number(newerMatch[1]);
    const unit = newerMatch[2].toLowerCase();
    const d = new Date();
    if (unit === 'd') d.setDate(d.getDate() - amount);
    else d.setHours(d.getHours() - amount);
    // IMAP SINCE compares dates only — use the start of that day
    criteria.since = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // from:<sender>  →  from: field
  const fromMatch = query.match(/from:(\S+)/i);
  if (fromMatch) {
    criteria.from = fromMatch[1];
  }

  // Any remaining words treated as a subject keyword
  const text = query
    .replace(/newer_than:\d+(?:d|h)/gi, "")
    .replace(/label:\S+/gi, "")
    .replace(/from:\S+/gi, "")
    .trim();
  if (text) criteria.subject = text;

  return Object.keys(criteria).length ? criteria : { all: true };
}

/**
 * Parse a newer_than query token and return the cutoff Date, or null.
 * Used to post-filter emails when IMAP SINCE lacks sub-day precision.
 */
function parseCutoff(query) {
  const m = query.match(/newer_than:(\d+)(d|h)/i);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2].toLowerCase();
  const d = new Date();
  if (unit === 'd') d.setDate(d.getDate() - amount);
  else d.setHours(d.getHours() - amount);
  return d;
}

/**
 * Extract the Gmail label/folder name from a query string (label:foo).
 * Returns null if no label specified.
 */
function extractLabel(query) {
  const m = query.match(/label:(\S+)/i);
  return m ? m[1] : null;
}

/**
 * Fetch emails from Gmail via IMAP and return them in the shape
 * expected by processEmail():  { subject, from, text, html, receivedAt }
 *
 * @param {string} [query] - Gmail-style search query (defaults to config.gmailQuery)
 * @returns {Promise<Array<{subject:string, from:string, text:string, html:string, receivedAt:string}>>}
 */
export async function fetchVacancyEmails(query) {
  const q = query || config.gmailQuery || "newer_than:1d";

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: config.gmailUser,
      pass: config.gmailAppPassword,
    },
    logger: false,
  });

  // Prevent unhandled 'error' events from crashing the process (e.g. ECONNRESET on boot)
  client.on('error', () => {});

  await client.connect();

  const emails = [];
  try {
    const label = extractLabel(q);
    const criteria = queryToImap(q);

    // Try named label → fall back to INBOX
    const candidates = label ? [label, "INBOX"] : ["INBOX"];

    let opened = false;
    for (const folder of candidates) {
      try {
        await client.mailboxOpen(folder, { readOnly: true });
        opened = true;
        break;
      } catch {
        // try next
      }
    }
    if (!opened) return [];

    const cutoff = parseCutoff(q);

    const uids = await client.search(criteria, { uid: true });
    if (!uids.length) return [];

    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      const receivedAt = parsed.date || new Date();
      // Post-filter for sub-day precision (e.g. newer_than:2h)
      if (cutoff && receivedAt < cutoff) continue;
      emails.push({
        subject: parsed.subject || "",
        from: parsed.from?.text || "",
        text: parsed.text || "",
        html: parsed.html || parsed.textAsHtml || "",
        receivedAt: receivedAt.toISOString(),
      });
    }
  } finally {
    await client.logout();
  }

  return emails;
}
