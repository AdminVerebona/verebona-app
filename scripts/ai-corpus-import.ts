/**
 * Lot 100B — import du corpus de référence #601 (ZIP ou dossier) dans le
 * manifeste et les fixtures natives du corpus.
 *
 *   npm run ai:corpus:import -- <livraison.zip|dossier>            # ESSAI : rapport ligne par ligne, rien n'est écrit
 *   npm run ai:corpus:import -- <livraison.zip|dossier> --write    # écrit fixtures, pièces, manifeste et rapport
 *   options : --by "<nom du développeur>" · --json
 *
 * Outil de DÉVELOPPEUR (le PO ne lance aucune commande). N'approuve RIEN :
 * chaque référence s'approuve ensuite individuellement au BO (Configuration
 * IA › Corpus de qualification). Format d'entrée : docs/exploitation/corpus-qualification-601.md.
 * Aucune base de données ; le ZIP privé n'est jamais publié (fichiers copiés
 * dans le dépôt : pièces nécessaires aux cas seulement, avec leur empreinte).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnvQuietly } from './lib/quiet-env';

const args = process.argv.slice(2);
const has = (n: string) => args.includes(n);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  loadEnvQuietly();
  const cible = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--by');
  if (!cible) { console.error('Usage : npm run ai:corpus:import -- <livraison.zip|dossier> [--write] [--by "nom"] [--json]'); process.exit(2); }
  const imp = await import('@/services/ai/governance/master-corpus/certification/importer');
  const { loadCorpusManifest, MANIFEST_PATH, REPO_ROOT, validateManifest } = await import('@/services/ai/governance/master-corpus/certification/manifest');
  const { liveVariablesFor } = await import('@/services/ai/governance/master-corpus/live');
  const src = statSync(cible).isDirectory() ? await imp.readDirectorySource(cible) : await imp.readZipSource(cible.split('/').pop() ?? cible, readFileSync(cible));
  const before = loadCorpusManifest();
  const r = await imp.convertImport(src, before, { liveVariables: liveVariablesFor, by: val('--by') ?? 'importeur-601' });
  const problems = validateManifest(r.manifest, null, before);
  if (has('--json')) console.log(JSON.stringify({ report: r.report, problems }, null, 2));
  else {
    process.stdout.write(imp.importReportText(r.report));
    for (const p of problems) console.log(`  ✗ manifeste : ${p}`);
  }
  if (!has('--write')) { console.log('\n(essai : rien n’a été écrit — relancer avec --write)'); return; }
  if (problems.length) { console.error('[ai:corpus:import] manifeste invalide : rien n’est écrit.'); process.exit(1); }
  for (const [rel, b] of r.writes) {
    const p = join(REPO_ROOT, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, b);
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(r.manifest, null, 2)}\n`);
  const dir = join(dirname(MANIFEST_PATH), 'imports');
  mkdirSync(dir, { recursive: true });
  const nom = `import-${r.report.at.slice(0, 19).replace(/[:T]/g, '-')}-${r.report.source.sha256.slice(0, 12)}.json`;
  writeFileSync(join(dir, nom), `${JSON.stringify(r.report, null, 2)}\n`);
  console.log(`\n[ai:corpus:import] écrit : ${r.writes.size} fichier(s), manifeste v${r.manifest.version}, rapport imports/${nom}. Relire puis commiter ; approbations au BO.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
