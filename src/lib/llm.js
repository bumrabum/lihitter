import { spawn } from 'node:child_process';

/**
 * LLM adapter — uses opencode CLI.
 *
 * Configure via .env:
 *   OPENCODE_MODEL=github-copilot/gpt-4.1 (default)
 *   LLM_PROVIDER=mock  → deterministic fake results, no CLI needed
 *
 * Response format:
 *   { "passed": true|false, "reasoning": "one sentence" }
 */

// ─── Shared system prompt (configurable per-check, falls back to this) ────────

export const DEFAULT_SYSTEM_PROMPT = `You are a job description analyst. You evaluate job postings against specific criteria.

Always respond with valid JSON and nothing else — no markdown, no prose outside the JSON.
Use exactly this shape:
{
  "passed": true,
  "reasoning": "One sentence explaining the decision."
}

\passed\ must be a boolean (true = the job passes the check, false = it fails).
\reasoning\ must be a single short sentence.`;

// ─── JSON parser ──────────────────────────────────────────────────────────────

function parseJsonResponse(raw) {
  // Strip markdown code fences if the model wrapped it
  const cleaned = raw.replace(/\`\`\`(?:json)?/gi, '').trim();
  // Find the first {...} block
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error('No JSON object found in LLM response');
  const obj = JSON.parse(match[0]);
  if (typeof obj.passed !== 'boolean') throw new Error('Missing boolean field "passed" in response');
  return {
    passed: obj.passed,
    reasoning: String(obj.reasoning || '').trim()
  };
}

// ─── Mock provider ────────────────────────────────────────────────────────────

function mockAsk(checkPrompt) {
  const passed = checkPrompt.length % 2 === 0;
  return {
    passed,
    reasoning: '[mock] Configure LLM_PROVIDER in .env to enable real checks.'
  };
}

// ─── OpenCode provider (shells out to `opencode run`) ─────────────────────────

// Returns raw text output from opencode (shared by single and batch modes)
async function opencodeAskRaw(systemPrompt, userContent) {
  const model = process.env.OPENCODE_MODEL || 'github-copilot/gpt-4.1';
  const fullPrompt = systemPrompt + '\n\n---\n\n' + userContent;

  return new Promise((resolve, reject) => {
    const args = ['run', '--model', model, '--format', 'json'];
    console.log(`[llm] Spawning: opencode ${args.join(' ')}`);
    const child = spawn('opencode', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 90000
    });

    child.stdin.end(fullPrompt);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', (code) => {
      console.log(`[llm] opencode exited with code ${code} (stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes)`);
      if (code !== 0 && code !== null) {
        return reject(new Error(`opencode exited ${code}: ${stderr.slice(0, 300)}`));
      }
      const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
      let text = '';
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'text' && ev.part?.text) {
            text += ev.part.text;
          }
        } catch { /* skip malformed lines */ }
      }
      if (!text) return reject(new Error('No text output from opencode'));
      resolve(text);
    });

    child.on('error', reject);
  });
}

async function opencodeAsk(systemPrompt, userContent) {
  const text = await opencodeAskRaw(systemPrompt, userContent);
  return parseJsonResponse(text);
}

// ─── Batch parser ────────────────────────────────────────────────────────────

function parseJsonArrayResponse(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  // Find outermost [...] block
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array found in LLM response');
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
  return arr.map((item, i) => {
    if (typeof item.passed !== 'boolean') throw new Error(`Item ${i} missing boolean "passed"`);
    return {
      name: String(item.name || '').trim(),
      passed: item.passed,
      reasoning: String(item.reasoning || '').trim()
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a single checklist check against a job description.
 *
 * @param {string} checkPrompt    - The check instruction (what to evaluate)
 * @param {object} vacancy        - { title, company, location, description }
 * @param {string} [systemPrompt] - Override system prompt (from checklist_items.system_prompt)
 * @returns {Promise<{ passed: boolean, reasoning: string }>}
 */
/**
 * Run all checklist checks in a single LLM call (quick mode).
 *
 * @param {Array<{ id, label, prompt }>} items
 * @param {object} vacancy - { title, company, location, description }
 * @returns {Promise<Array<{ id, name, passed, reasoning }>>}
 */
export async function askLLMBatch(items, vacancy) {
  const provider = (process.env.LLM_PROVIDER || 'opencode').toLowerCase();

  if (provider === 'mock') {
    return items.map(item => ({
      id: item.id,
      name: item.label,
      ...mockAsk(item.prompt)
    }));
  }

  const systemPrompt = `You are a job description analyst. Evaluate the job posting against every check listed below.

Always respond with valid JSON and nothing else — no markdown, no prose outside the JSON.
Return an array with one entry per check, in the same order:
[
  { "name": "<check label>", "passed": true|false, "reasoning": "One sentence." },
  ...
]
"name" must exactly match the label given for each check.
"passed" must be a boolean (true = the job passes the check, false = it fails).
"reasoning" must be a single short sentence.`;

  const checksText = items
    .map((item, i) => `${i + 1}. [${item.label}] ${item.prompt}`)
    .join('\n');

  const userContent = `Job Title: ${vacancy.title}
Company: ${vacancy.company}
Location: ${vacancy.location}

Job Description:
${vacancy.description}

---
Checks to perform:
${checksText}`;

  if (provider !== 'opencode') {
    console.warn(`[llm] Unknown LLM_PROVIDER "${provider}", using opencode.`);
  }

  try {
    const raw = await opencodeAskRaw(systemPrompt, userContent);
    const results = parseJsonArrayResponse(raw);
    // Map results back to items by position (primary) or name (fallback)
    return items.map((item, i) => {
      const r = results[i] || results.find(x => x.name === item.label);
      if (!r) return { id: item.id, name: item.label, passed: false, reasoning: 'No result returned by LLM' };
      return { id: item.id, name: item.label, passed: r.passed, reasoning: r.reasoning };
    });
  } catch (err) {
    console.error('[llm] Batch call failed:', err.message);
    return items.map(item => ({
      id: item.id,
      name: item.label,
      passed: false,
      reasoning: `LLM batch call failed: ${err.message}`
    }));
  }
}

export async function askLLM(checkPrompt, vacancy, systemPrompt) {
  const provider = (process.env.LLM_PROVIDER || 'opencode').toLowerCase();
  const sysPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const userContent = `Job Title: ${vacancy.title}
Company: ${vacancy.company}
Location: ${vacancy.location}

Job Description:
${vacancy.description}

---
Check to perform:
${checkPrompt}`;

  try {
    if (provider === 'mock') {
      return mockAsk(checkPrompt);
    }
    if (provider !== 'opencode') {
      console.warn(`[llm] Unknown LLM_PROVIDER "${provider}", using opencode.`);
    }
    return await opencodeAsk(sysPrompt, userContent);
  } catch (err) {
    console.error(`[llm] Error calling opencode:`, err.message);
    return { passed: false, reasoning: `LLM call failed: ${err.message}` };
  }
}
