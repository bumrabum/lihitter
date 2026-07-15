/**
 * Parser tests — no network, no browser, no credentials required.
 * Uses the 3 real captured pages stored in captured-pages/.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLinkedInJobHtml } from "../src/lib/parseJobHtml.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

const FIXTURES = [
  {
    file: "captured-pages/page-01.html",
    url: "https://www.linkedin.com/jobs/view/4398875912/",
    expected: {
      title: "Solutions Engineer",
      company: "ORO Labs",
      location: "EMEA"
    }
  },
  {
    file: "captured-pages/page-02.html",
    url: "https://www.linkedin.com/jobs/view/4392674463/",
    expected: {
      title: "Senior Solutions Engineer",
      company: "CKEditor",
      location: "Poland"
    }
  },
  {
    file: "captured-pages/page-03.html",
    url: "https://www.linkedin.com/jobs/view/4398724022/",
    expected: {
      title: "Solutions Engineer - DACH",
      company: "Ashby",
      location: "European Union"
    }
  }
];

describe("parseLinkedInJobHtml", () => {
  for (const { file, url, expected } of FIXTURES) {
    describe(file, () => {
      const html = fs.readFileSync(path.join(ROOT, file), "utf8");
      const result = parseLinkedInJobHtml(html, url);

      test("returns the correct URL", () => {
        assert.equal(result.url, url);
      });

      test("extracts title", () => {
        assert.equal(result.title, expected.title);
      });

      test("extracts company", () => {
        assert.equal(result.company, expected.company);
      });

      test("extracts location", () => {
        assert.equal(result.location, expected.location);
      });

      test("extracts a non-empty description", () => {
        assert.ok(result.description.length > 100, `Description too short: "${result.description.slice(0, 80)}"`);
      });
    });
  }
});
