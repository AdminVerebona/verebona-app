/**
 * Lot 100B — manifeste versionné du corpus de qualification IA (ticket #601).
 *
 *   npm run ai:corpus:manifest              # contrôle (CI) : manifeste conforme, aucune fixture sans entrée
 *   npm run ai:corpus:manifest -- --write   # ajoute les fixtures sans entrée (classement automatique) et écrit
 *   npm run ai:corpus:manifest -- --json    # rapport de classement (comptes par classe, statut, opération)
 *
 * Outil de DÉVELOPPEUR (jamais demandé au PO). N'approuve rien : le statut
 * RÉFÉRENCE_APPROUVÉE ne s'obtient que par une approbation individuelle au BO.
 * Aucune base de données.
 */
import { writeFileSync } from 'node:fs';
import { loadEnvQuietly } from './lib/quiet-env';

const args = process.argv.slice(2);
const has = (n: string) => args.includes(n);

async function main() {
  loadEnvQuietly();
  const { readRepoCorpus, updateManifest, fixturesOnDisk } = await import('@/services/ai/governance/master-corpus/certification/generate');
  const { loadCorpusManifest, validateManifest, MANIFEST_PATH } = await import('@/services/ai/governance/master-corpus/certification/manifest');
  const { existsSync } = await import('node:fs');
  const corpus = await readRepoCorpus();
  const existing = existsSync(MANIFEST_PATH) ? loadCorpusManifest() : null;
  const { manifest, added } = await updateManifest(existing, corpus);
  const problems = validateManifest(manifest, fixturesOnDisk(corpus.cases), existing);
  type Entry = (typeof manifest.entries)[number];
  const count = (f: (e: Entry) => string | null, only: (e: Entry) => boolean = () => true) => {
    const m: Record<string, number> = {};
    for (const e of manifest.entries.filter(only)) { const k = f(e) ?? '—'; m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  const report = {
    version: manifest.version, entries: manifest.entries.length, added,
    byProvenance: count((e) => e.provenance), byClass: count((e) => e.historicalClass), byStatus: count((e) => e.status),
    historical86: count((e) => e.historicalClass, (e) => e.provenance === 'HISTORIQUE_86'),
    problems,
  };
  if (has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[ai:corpus:manifest] v${report.version} · ${report.entries} entrée(s) · ajoutées : ${added.length}`);
    console.log(`  par provenance : ${JSON.stringify(report.byProvenance)}`);
    console.log(`  86 historiques : ${JSON.stringify(report.historical86)}`);
    console.log(`  par statut : ${JSON.stringify(report.byStatus)}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  if (has('--write')) {
    if (problems.length) { console.error('[ai:corpus:manifest] manifeste NON écrit : problèmes ci-dessus.'); process.exit(1); }
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[ai:corpus:manifest] écrit : ${MANIFEST_PATH}`);
    return;
  }
  if (problems.length || added.length) {
    if (added.length) console.error(`[ai:corpus:manifest] ${added.length} fixture(s) sans entrée au manifeste : lancer avec --write puis relire.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
