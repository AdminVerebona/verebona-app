/**
 * Préconditions du retrait des prompts d'étapes et du relais legacy —
 * CDC 15 §29 étape 15, §32, D-02, HC-06. N'EFFACE RIEN.
 *
 *   npm run ai:cutover-check                 # base si DATABASE_URL, sinon analyse statique
 *   npm run ai:cutover-check -- --days 60    # fenêtre des appels observés (défaut 30)
 *   npm run ai:cutover-check -- --json       # rapport JSON
 *   npm run ai:cutover-check -- --report     # rapport seul (sortie 0 même si NON PRÊT)
 *
 * Strict par défaut : sortie 1 tant que le retrait n'est pas prêt. Lecture
 * seule : jamais de migration.
 *
 * Contrôles par opération dépréciée (logique : `governance/cutover/cutover-check.ts`) :
 * traitement en master sur la version ACTIVE, commutateur `enabled`, drapeau
 * AI_* sur le nouveau moteur, corpus vert, aucun appel sur N jours. Sans base :
 * les contrôles qui la demandent sont « à vérifier ».
 *
 * Produit la LISTE EXACTE des opérations et fichiers supprimables, plus les
 * fichiers de prompt orphelins (cités par aucune opération) et les appelants
 * à adapter dans le code.
 */
import { loadEnvQuietly } from './lib/quiet-env';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { AI_OPERATIONS, operationDeprecation } from '@/services/ai/registry/operations';
import { treatmentForUseCase, type Treatment } from '@/services/ai/config/treatments';
import { promptFileCandidates } from '@/services/ai/prompts/prompt-loader';
import { USE_CASE_FLAGS } from '@/services/ai/flags/use-case-flags';
import { getFlagMode } from '@/services/ai/flags/ai-feature-flags';
import { getRolloutMode } from '@/services/canonical/rollout';
import { computeCutover, type CutoverReport } from '@/services/ai/governance/cutover/cutover-check';

const { hasDatabase } = loadEnvQuietly();
const ROOT = process.cwd();
const PROMPTS = join(ROOT, 'src/services/ai/prompts');
const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(val('--days') ?? 30);

/** Commutateur de déploiement exigé par traitement (plan CDC 15, § Déploiement). */
const SWITCH_BY_TREATMENT: Partial<Record<Treatment, Parameters<typeof getRolloutMode>[0]>> = {
  T1: 'AI_T1_ANALYSIS_MODE',
  T2: 'ASSISTANT_CANONICAL_READ',
  T3: 'T3_NEGATIVE_RECONCILIATION',
  T4: 'AI_T4_EFFECTS',
};

function walk(dir: string, out: string[] = [], withTests = false): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out, withTests);
    else if (/\.(ts|tsx|mjs)$/.test(f) && (withTests || !/__tests__|\.test\.|\.e2e\./.test(p))) out.push(p);
  }
  return out;
}

async function main() {
  const promptFiles = readdirSync(PROMPTS).flatMap((d) => {
    const p = join(PROMPTS, d);
    return statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith('.txt')).map((f) => ({ promptCode: f.replace(/\.txt$/, ''), path: relative(ROOT, join(p, f)) }))
      : [];
  });
  const sources = walk(join(ROOT, 'src')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));
  const tous = [...walk(join(ROOT, 'src'), [], true), ...walk(join(ROOT, 'scripts'), [], true)]
    .map((p) => ({ p, text: readFileSync(p, 'utf8') }));
  const referencesOf = (code: string) => tous.filter((s) => s.text.includes(code)).map((s) => relative(ROOT, s.p));
  const registre = join(ROOT, 'src/services/ai/registry/operations.ts');
  const callersOf = (code: string) => sources
    .filter((s) => s.p !== registre && s.text.includes(`'${code}'`))
    .map((s) => relative(ROOT, s.p));

  let activeArchitecture: Partial<Record<Treatment, 'steps' | 'master'>> | null = null;
  let corpusGreen: Partial<Record<Treatment, boolean>> | null = null;
  let usage: Record<string, number> | null = null;
  const warnings: string[] = [];

  if (hasDatabase) {
    try {
      // Contrôle en LECTURE seule : jamais `ensureMigrations()` (un script de
      // contrôle ne modifie pas le schéma). Tables absentes : message clair.
      const { pgClient } = await import('@/db');
      const manquantes = (await pgClient.unsafe(
        `SELECT t FROM unnest(ARRAY['ai_config_versions','ai_config_entries','ai_usage_event','ai_master_corpus_runs']) AS t
          WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = t)`,
      )) as unknown as Array<{ t: string }>;
      if (manquantes.length) throw new Error(`table(s) absente(s) : ${manquantes.map((m) => m.t).join(', ')} — appliquer les migrations`);
      const { getActiveVersion } = await import('@/services/ai/config/config-version.repository');
      const { getAiEnvironment } = await import('@/services/ai/config/environment');
      const { promptArchitectureOf } = await import('@/services/ai/config/config-types');
      const active = await getActiveVersion(getAiEnvironment());
      if (active) {
        activeArchitecture = Object.fromEntries(active.entries.map((e) => [e.treatment, promptArchitectureOf(e)]));
        const { checkMasterActivation } = await import('@/services/ai/governance/master-corpus/activation-guard');
        const gate = await checkMasterActivation(active);
        corpusGreen = Object.fromEntries(gate.entries.map((e) => [e.treatment, e.status === 'GREEN']));
      } else {
        warnings.push('aucune version ACTIVE dans cet environnement');
        activeArchitecture = {};
        corpusGreen = {};
      }
      const rows = (await pgClient.unsafe(
        `SELECT operation_type, COUNT(*)::int AS n FROM ai_usage_event
          WHERE created_at >= NOW() - ($1 || ' days')::interval GROUP BY operation_type`,
        [String(days)] as never[],
      )) as unknown as Array<{ operation_type: string; n: number }>;
      usage = Object.fromEntries(rows.map((r) => [r.operation_type, Number(r.n)]));
    } catch (e) {
      warnings.push(`base illisible (${(e as Error).message}) : analyse statique`);
      activeArchitecture = null; corpusGreen = null; usage = null;
    }
  } else {
    warnings.push('DATABASE_URL absente : analyse statique, contrôles en base « à vérifier »');
  }

  const report = computeCutover({
    operations: Object.values(AI_OPERATIONS),
    deprecationOf: operationDeprecation,
    treatmentOf: (op) => treatmentForUseCase(op.useCaseCode),
    activeArchitecture,
    switches: Object.fromEntries(Object.entries(SWITCH_BY_TREATMENT)
      .map(([t, name]) => [t, { name: name!, mode: getRolloutMode(name!) }])),
    // Usage sans drapeau (T5, T6 depuis le lot 16b) : nouveau moteur seul.
    flagOf: (op) => {
      const f = USE_CASE_FLAGS[op.useCaseCode];
      return f ? { name: f, mode: getFlagMode(f) } : { name: `${op.useCaseCode} (sans drapeau)`, mode: 'enabled' };
    },
    corpusGreen,
    usage,
    days,
    promptFileOf: (code, op) => {
      const p = promptFileCandidates(code, op.useCaseCode, PROMPTS).find((c) => existsSync(c));
      return p ? relative(ROOT, p) : null;
    },
    promptFiles,
    callersOf,
    referencesOf,
  });

  if (args.includes('--json')) console.log(JSON.stringify({ ...report, warnings }, null, 2));
  else print(report, warnings);
  // Strict par défaut : NON PRÊT ⇒ sortie 1 ; `--report` pour un rapport en 0.
  process.exit(!report.ready && !args.includes('--report') ? 1 : 0);
}

function print(r: CutoverReport, warnings: string[]) {
  console.log(`[ai:cutover-check] mode ${r.mode} · fenêtre ${r.days} j · ${r.operations.length} opération(s) dépréciée(s)`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  const icone = { ok: '✓', bloquant: '✗', 'à vérifier': '?' } as const;
  for (const o of r.operations) {
    const repl = o.deprecation.reason === 'LEGACY_RELAY' ? 'relais legacy' : `→ ${o.deprecation.replacedBy}`;
    console.log(`\n${icone[o.removable]} ${o.operationCode} (${o.treatment}, ${repl}) : ${o.removable}`);
    for (const p of o.preconditions.filter((x) => x.status !== 'ok')) console.log(`    ${icone[p.status]} ${p.code} — ${p.detail}`);
    if (o.files.length) console.log(`    fichiers : ${o.files.join(', ')}`);
    if (o.callers.length) console.log(`    appelants à adapter : ${o.callers.join(', ')}`);
  }
  console.log('\n── Opérations supprimables (liste exacte) ──');
  console.log(r.removableOperations.length ? r.removableOperations.map((x) => `  · ${x}`).join('\n') : '  (aucune)');
  console.log('── Fichiers supprimables (liste exacte) ──');
  console.log(r.removableFiles.length ? r.removableFiles.map((x) => `  · ${x}`).join('\n') : '  (aucun)');
  console.log(`   dont orphelins (cités par aucune opération ni aucun fichier) : ${r.orphanPromptFiles.length}`);
  if (r.referencedOrphans.length) {
    console.log('── Prompts orphelins encore référencés (à vérifier) ──');
    for (const o of r.referencedOrphans) console.log(`  ? ${o.path} — cité par ${o.references.join(', ')}`);
  }
  console.log(`\nRetrait ${r.ready ? 'PRÊT' : 'NON PRÊT'} — rien n'a été supprimé.`);
}

main().catch((e) => { console.error('[ai:cutover-check]', e); process.exit(1); });
