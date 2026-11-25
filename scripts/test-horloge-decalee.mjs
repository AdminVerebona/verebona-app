#!/usr/bin/env node
/**
 * Suite de tests sous horloge décalée (détection des « bombes à retardement »).
 * Multiplateforme (Windows/Linux) : pose TEST_CLOCK_OFFSET_DAYS puis lance vitest.
 *
 *   npm run test:horloge-decalee                 # unitaires, +400 jours
 *   npm run test:horloge-decalee -- 45 <fichiers> # décalage et fichiers au choix
 *
 * Règle et limites : docs/exploitation/tests-horloge.md
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const jours = args.length && /^-?\d+(\.\d+)?$/.test(args[0]) ? args.shift() : '400';
console.log(`[horloge-decalee] TEST_CLOCK_OFFSET_DAYS=${jours}`);
const r = spawnSync('npx', ['vitest', '--run', ...args], {
  stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, TEST_CLOCK_OFFSET_DAYS: jours },
});
process.exit(r.status ?? 1);
