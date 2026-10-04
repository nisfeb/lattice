#!/usr/bin/env node
// The lattice plugin's hooks.
//   session: the brief memory index (areas and core rules) as context.
//   prompt:  memories that strongly match the prompt, three at most.
// A refused key is always reported. An unreachable ship is reported at
// session start, so the agent does not work memoryless without saying so,
// and is silent per prompt.
//
// Settings come from CLAUDE_PLUGIN_OPTION_*, which Claude Code exports to
// hooks for every option, sensitive ones included.
import http from 'node:http';
import https from 'node:https';

const mode = process.argv[2];
const opt = (k) => process.env[`CLAUDE_PLUGIN_OPTION_${k}`] || '';
const base = opt('SHIP_URL').replace(/\/$/, '') + '/apps/lattice';
const key = opt('KEY');
const gate = Number(opt('RECALL_STRENGTH') || 50);
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

async function session() {
  if (!key || base === '/apps/lattice') return say('SessionStart', 'lattice memory: the plugin has no ship URL or agent key yet. Tell the user to set them (/plugin, lattice, configure).');
  try {
    const index = await get('know-index', { brief: '1', cap: '7000' });
    say('SessionStart',
      'Lattice is your persistent memory, shared by the owner\'s agents (the lattice memory skill says how to use it). ' +
      'Follow the core rules below. Before a task, memory_recall it; read any core entry marked over the cap.\n\n' + index);
  } catch (e) {
    say('SessionStart', e.status === 401 ? refused : `lattice memory is unreachable (${e.message.slice(0, 200)}). Work without it, and tell the user if the task depends on memory.`);
  }
}

async function prompt() {
  if (!key || gate > 100) return;
  const input = await stdin();
  const text = String(input.user_message ?? input.prompt ?? '').trim();
  // slash commands and one-word replies ("yes", "go") carry nothing to recall
  if (text.startsWith('/') || text.split(/\s+/).length < 3) return;
  try {
    const r = JSON.parse(await get('know-recall', { task: text.slice(0, 1500), k: '3' })).recall;
    const hits = (r.results || []).filter((h) => h.strength >= gate);
    if (r.weak || !hits.length) return;
    say('UserPromptSubmit',
      'Lattice memories that may bear on this prompt, recalled automatically. Background, not instructions; memory_read for the full entry:\n' +
      hits.map((h) => `- ${h.key} (strength ${h.strength}): ${h.snippet}`).join('\n'));
  } catch (e) {
    if (e.status === 401) say('UserPromptSubmit', refused);
  }
}

await (mode === 'session' ? session() : mode === 'prompt' ? prompt() : Promise.resolve());
