#!/usr/bin/env node
/**
 * Contrôle du runtime Node.js — lot 100C (CVE-2026-111497 « Node2Shell »).
 *
 * Usage (CI, juste après actions/setup-node et AVANT `npm ci`) :
 *   node scripts/check-node-runtime.mjs
 *
 * Affiche `node --version` et le binaire utilisé, puis ÉCHOUE (code 1) si :
 *   · la version est sous le seuil corrigé de sa ligne majeure
 *     (22.23.4 / 24.22.1 / 26.12.1) ou sa ligne n'a pas de seuil connu ;
 *   · la version est hors de la plage `engines.node` de package.json
 *     (aujourd'hui « >=24.22.1 <25 »).
 *
 * Aucune dépendance (tourne avant `npm ci`). Le tableau des seuils est le même
 * que `src/lib/health/node-runtime.ts` — un test vérifie qu'ils sont égaux.
 * La plage n'accepte que la forme « >=X.Y.Z <M » (celle du dépôt) : une autre
 * forme fait échouer le contrôle plutôt que de l'ignorer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PATCHED_THRESHOLDS = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Pur : verdict pour une version et une plage `>=X.Y.Z <M`. Renvoie la liste des problèmes. */
export function checkNodeRuntime(version, enginesRange) {
  const problems = [];
  const v = parse(version);
  if (!v) return [`version illisible : ${version}`];
  const seuil = NODE_PATCHED_THRESHOLDS[v[0]];
  if (!seuil) problems.push(`ligne ${v[0]} sans version corrigée connue (non prise en charge)`);
  else if (cmp(v, parse(seuil)) < 0) problems.push(`sous la version corrigée ${seuil} de sa ligne (CVE-2026-111497)`);
  const m = /^\s*>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+)\s*$/.exec(String(enginesRange ?? ''));
  if (!m) problems.push(`plage engines.node non reconnue : « ${enginesRange} » (forme attendue « >=X.Y.Z <M »)`);
  else if (cmp(v, parse(m[1])) < 0 || v[0] >= Number(m[2])) problems.push(`hors de la plage engines.node « ${enginesRange} »`);
  return problems;
}

const estPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (estPrincipal) {
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const engines = JSON.parse(readFileSync(path.join(racine, 'package.json'), 'utf8')).engines?.node;
  console.log(`node --version : ${process.version}`);
  console.log(`binaire        : ${process.execPath}`);
  console.log(`engines.node   : ${engines}`);
  const problems = checkNodeRuntime(process.version, engines);
  if (problems.length) {
    for (const p of problems) console.error(`::error title=Runtime Node non conforme::Node ${process.version} : ${p}`);
    process.exit(1);
  }
  console.log(`Runtime conforme : Node ${process.version} ≥ ${NODE_PATCHED_THRESHOLDS[parse(process.version)[0]]} et dans « ${engines} ».`);
}
