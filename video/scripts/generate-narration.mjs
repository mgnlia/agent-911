#!/usr/bin/env node
// Generates one narration mp3 per scene using edge-tts (free MS Neural voices,
// no API key). Outputs to ../public/narration/<scene>.mp3.
//
// Run: node scripts/generate-narration.mjs

import {spawnSync} from 'node:child_process';
import {mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'narration');
mkdirSync(OUT_DIR, {recursive: true});

// Voice: Guy is crisp, neutral; swap to en-US-AriaNeural for female delivery.
const VOICE = process.env.VOICE ?? 'en-US-GuyNeural';
// Speak slightly faster — narration should be snappy.
const RATE = process.env.RATE ?? '+8%';

/** @type {Array<{id: string; text: string}>} */
const SCENES = [
  {
    id: 'title',
    text: 'Agent Nine One One. The rescue layer for autonomous onchain agents.',
  },
  {
    id: 'problem',
    text: 'February twenty twenty six. Four hundred million dollars lost to an AI agent cascade. When the agent dies, the position stays open.',
  },
  {
    id: 'healthy',
    text: 'A treasury agent runs. Every second, a heartbeat. Funds move only when the watchdog quorum says the agent is dead.',
  },
  {
    id: 'kill',
    text: 'Something kills the agent. Watch who comes to save it.',
  },
  {
    id: 'watchdogs',
    text: 'Three watchdogs, three separate AXL nodes. Each signs independently. Two of three is enough.',
  },
  {
    id: 'rescue',
    text: 'The quorum confirms. Keeper Hub executes, only after the runbook hash matches onchain. Funds land at the safe.',
  },
  {
    id: 'receipt',
    text: 'Live on zero G testnet. Kill to safe: twenty point five seconds. Every receipt onchain.',
  },
  {
    id: 'stack',
    text: 'Every sponsor is load bearing. Zero G, Gensyn AXL, Keeper Hub, Uniswap, ENS, and ERC seventy eight fifty seven.',
  },
  {
    id: 'outro',
    text: 'Autonomous agents need an external failure oracle. Agent Nine One One is the first instance.',
  },
];

let failures = 0;
for (const scene of SCENES) {
  const out = join(OUT_DIR, `${scene.id}.mp3`);
  if (existsSync(out) && process.env.REGEN !== '1') {
    console.log(`skip ${scene.id} (exists; set REGEN=1 to overwrite)`);
    continue;
  }
  console.log(`rendering ${scene.id}...`);
  const r = spawnSync('edge-tts', [
    '--voice', VOICE,
    '--rate', RATE,
    '--text', scene.text,
    '--write-media', out,
  ], {stdio: 'inherit'});
  if (r.status !== 0) {
    console.error(`edge-tts failed for ${scene.id}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`${failures} scene(s) failed`);
  process.exit(1);
}
console.log(`done → ${OUT_DIR}`);
