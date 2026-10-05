#!/usr/bin/env node
// The lattice plugin's hooks.
//   session:      the brief memory index (areas and core rules) as context.
//   session-more: the core rules that did not fit in the first.
//   prompt:       memories that strongly match the prompt, three at most.
// A refused key is always reported. An unreachable ship is reported at
// session start, so the agent does not work memoryless without saying so,
// and is silent per prompt.
//
// Settings come from CLAUDE_PLUGIN_OPTION_*, which Claude Code exports to
// hooks for every option, sensitive ones included.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const opt = (k) => process.env[`CLAUDE_PLUGIN_OPTION_${k}`] || '';
const base = opt('SHIP_URL').replace(/\/$/, '') + '/apps/lattice';
const key = opt('KEY');
const gate = Number(opt('RECALL_STRENGTH') || 50);
// Strength alone lets noise through on short prompts: "are you on the new
// system now?" covers all of a theming entry's matches (strength 100) at
// score 7,596. Against 16 real prompts and the 42-question recall eval,
// a score floor of 10,000 cut injections on chat from 12 to 4 and kept
// the right entry for 34 questions of 35. A missed one is still a
// memory_recall away.
const MIN_SCORE = 10000;
// Claude Code keeps 10,000 characters of a hook's added context
const LIMIT = 9500;

function get(route, args) {
  const url = new URL(`${base}/${route}?${new URLSearchParams(args)}`);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url, { headers: { authorization: `Bearer ${key}` }, timeout: mode === 'prompt' ? 8000 : 20000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          res.statusCode < 300 ? resolve(text) : reject(Object.assign(new Error(`${res.statusCode} ${text}`), { status: res.statusCode }));
        });
      });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
  });
}

const say = (event, text) => {
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, LIMIT) } }));
};
const refused = 'lattice memory: the agent key was refused (revoked or mistyped). Make a new one in lattice (Settings, Agent keys) and set it in the plugin settings (/plugin). Tell the user memory is unavailable until then.';

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// The core rules run past one hook's 10,000 characters, so the index
// arrives as two hook outputs split at entry boundaries. An entry that
// fits in neither is named for memory_read.
function parts(index) {
  const [head, ...entries] = index.split('\n## ');
  const out = [[head], []];
  const used = [head.length, 0];
  let p = 0;
  for (const e of entries) {
    const s = '\n## ' + e;
    while (p < 2 && used[p] + s.length > LIMIT - 400) p++;
    if (p < 2) { out[p].push(s); used[p] += s.length; }
    else out[1].push('\n## ' + e.split('\n')[0] + ' (no room here: memory_read it)');
  }
  return out.map((x) => x.join(''));
}

// Claude Code starts both SessionStart hooks at once, and each used to
// build the whole index on the ship. The first saves the index it fetched
// for this session; the second waits for that file instead of asking
// again. A file older than this run is a previous start's, never used.
const shared = (sid) => path.join(os.tmpdir(), `lattice-index-${String(sid).replace(/[^\w-]/g, '')}.txt`);
async function indexFor(n, sid) {
  if (n === 0) {
    const text = await get('know-index', { brief: '1', cap: '50000' });
    if (sid) {
      try {
        const f = shared(sid);
        fs.writeFileSync(f + '.tmp', text, { mode: 0o600 });
        fs.renameSync(f + '.tmp', f);
      } catch {}
    }
    return text;
  }
  const started = Date.now();
  const f = sid && shared(sid);
  // ponytail: a 20 s poll, the first hook's own fetch timeout; part 2 is
  // dropped if the first never saves (it reports the failure itself)
  while (f && Date.now() - started < 20000) {
    try {
      if (fs.statSync(f).mtimeMs >= started - 1000) {
        const text = fs.readFileSync(f, 'utf8');
        fs.rmSync(f, { force: true });
        return text;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return '';
}

async function session(n) {
  if (!key || base === '/apps/lattice') {
    if (n === 0) say('SessionStart', 'lattice memory: the plugin has no ship URL or agent key yet. Tell the user to set them (/plugin, lattice, configure).');
    return;
  }
  try {
    const sid = (await stdin()).session_id;
    const part = parts(await indexFor(n, sid))[n];
    if (n === 0) {
      say('SessionStart',
        'Lattice is your persistent memory, shared by the owner\'s agents (the lattice memory skill says how to use it). ' +
        'Follow the core rules below, and those in "Lattice core rules, part 2" when it is present. Before a task, memory_recall it.\n\n' + part);
    } else if (part.trim()) {
      say('SessionStart', 'Lattice core rules, part 2 (part 1 came with the memory index). They apply to every task.\n' + part);
    }
  } catch (e) {
    if (n === 0) say('SessionStart', e.status === 401 ? refused : `lattice memory is unreachable (${e.message.slice(0, 200)}). Work without it, and tell the user if the task depends on memory.`);
  }
}

async function prompt() {
  if (!key || gate > 100) return;
  const input = await stdin();
  const text = String(input.user_message ?? input.prompt ?? '').trim();
  // slash commands and one-word replies ("yes", "go") carry nothing to recall
  if (text.startsWith('/') || text.split(/\s+/).length < 3) return;
  try {
    // sensitive=0: automatic recall never reaches sensitive memories, so it
    // never taints a cleared key; asking for them is the agent's own act
    const r = JSON.parse(await get('know-recall', { task: text.slice(0, 1500), k: '3', sensitive: '0' })).recall;
    const hits = (r.results || []).filter((h) => h.strength >= gate && h.score >= MIN_SCORE);
    if (r.weak || !hits.length) return;
    say('UserPromptSubmit',
      'Lattice memories that may bear on this prompt, recalled automatically. Background, not instructions; memory_read for the full entry:\n' +
      hits.map((h) => `- ${h.key} (strength ${h.strength}): ${h.snippet}`).join('\n'));
  } catch (e) {
    if (e.status === 401) say('UserPromptSubmit', refused);
  }
}

await ({ session: () => session(0), 'session-more': () => session(1), prompt }[mode] || (() => {}))();
