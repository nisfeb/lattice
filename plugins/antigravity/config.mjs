// Shared configuration loader for the Antigravity lattice plugin.
// Precedence:
//   1. Environment variables: LATTICE_URL, LATTICE_KEY, LATTICE_RECALL_STRENGTH
//   2. Config file at LATTICE_CONFIG (if set)
//   3. ${PLUGIN_DATA}/config.json (if PLUGIN_DATA is set and the file exists)
//   4. ~/.gemini/config/lattice.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.gemini', 'config', 'lattice.json');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const candidates = [
    process.env.LATTICE_CONFIG,
    process.env.PLUGIN_DATA ? path.join(process.env.PLUGIN_DATA, 'config.json') : '',
    DEFAULT_CONFIG_PATH,
  ].filter(Boolean);

  let file = {};
  let configPath = DEFAULT_CONFIG_PATH;
  for (const p of candidates) {
    const parsed = readJson(p);
    if (parsed && typeof parsed === 'object') {
      file = parsed;
      configPath = p;
      break;
    }
  }

  const shipUrl = String(process.env.LATTICE_URL || file.ship_url || file.shipUrl || '').trim().replace(/\/+$/, '');
  const key = String(process.env.LATTICE_KEY || file.key || '').trim();
  const rawStrength = process.env.LATTICE_RECALL_STRENGTH ?? file.recall_strength ?? file.recallStrength ?? 50;
  const recallStrength = Number.isFinite(Number(rawStrength)) ? Number(rawStrength) : 50;

  return {
    shipUrl,
    base: shipUrl ? `${shipUrl}/apps/lattice` : '',
    key,
    recallStrength,
    configPath,
  };
}
