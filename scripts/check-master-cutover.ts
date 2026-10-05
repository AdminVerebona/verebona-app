/**
 * GARDE de l'architecture cible (prompts maîtres seuls) — CDC 15 §29 étape
 * 15, §32, D-02, HC-06 ; lot 16b. N'EFFACE RIEN, ne migre rien.
 *
 *   npm run ai:cutover-check                 # base si DATABASE_URL, sinon analyse statique
 *   npm run ai:cutover-check -- --days 60    # fenêtre des appels observés (défaut 30)
 *   npm run ai:cutover-check -- --json       # rapport JSON
 *   npm run ai:cutover-check -- --report     # rapport seul (sortie 0 même si un contrôle bloque)
 *
 * Strict par défaut : sortie 1 si un contrôle BLOQUE (opération modèle hors
 * master, prompt orphelin, gabarit historique, configuration stockée
 * `steps`). Les avertissements (variable retirée encore posée, appel récent à
 * une opération retirée) ne font pas échouer. Sans base : la configuration
 * stockée et les appels observés sont « à vérifier ». Intégré à
 * `npm run ai:verify`.
 *
 * Logique : `governance/cutover/cutover-check.ts`.
 */
import { loadEnvQuietly } from './lib/quiet-env';
import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { AI_OPERATIONS, isTargetArchitectureOperation } from '@/services/ai/registry/operations';
import { retiredVariablesSet } from '@/services/ai/config/retired-variables';
import { computeCutover, type CutoverReport } from '@/services/ai/governance/cutover/cutover-check';

const { hasDatabase } = loadEnvQuietly();
const ROOT = process.cwd();
const PROMPTS = join(ROOT, 'src/services/ai/prompts');
const LEGACY_TEMPLATES = join(ROOT, 'src/services/document-ai/prompts');
const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(val('--days') ?? 30);

async function main() {
  const promptFiles = readdirSync(PROMPTS).flatMap((d) => {
    const p = join(PROMPTS, d);
    return statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith('.txt')).map((f) => ({ promptCode: f.replace(/\.txt$/, ''), path: relative(ROOT, join(p, f)) }))
      : [];
  });
  const legacyTemplates = existsSync(LEGACY_TEMPLATES)
    ? readdirSync(LEGACY_TEMPLATES).filter((f) => f.endsWith('.txt')).map((f) => relative(ROOT, join(LEGACY_TEMPLATES, f)))
    : [];

  let storedSteps: Array<{ versionId: number; treatment: string }> | null = null;
  let usage: Record<string, number> | null = null;
  const warnings: string[] = [];

  if (hasDatabase) {
    try {
      // Contrôle en LECTURE seule : jamais `ensureMigrations()` (un script de
      // contrôle ne modifie pas le schéma). Tables absentes : message clair.
      const { pgClient } = await import('@/db');
      const manquantes = (await pgClient.unsafe(
        `SELECT t FROM unnest(ARRAY['ai_config_entries','ai_usage_event']) AS t
          WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = t)`,
      )) as unknown as Array<{ t: string }>;
      if (manquantes.length) throw new Error(`table(s) absente(s) : ${manquantes.map((m) => m.t).join(', ')} — appliquer les migrations`);
      const colonne = (await pgClient.unsafe(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'ai_config_entries' AND column_name = 'prompt_architecture'`,
      )) as unknown as unknown[];
      storedSteps = colonne.length
        ? ((await pgClient.unsafe(
          `SELECT version_id AS "versionId", treatment FROM ai_config_entries
            WHERE prompt_architecture = 'steps' ORDER BY version_id, treatment`,
        )) as unknown as Array<{ versionId: number; treatment: string }>).map((r) => ({ versionId: Number(r.versionId), treatment: r.treatment }))
        : [];
      const rows = (await pgClient.unsafe(
        `SELECT operation_type, COUNT(*)::int AS n FROM ai_usage_event
          WHERE created_at >= NOW() - ($1 || ' days')::interval GROUP BY operation_type`,
        [String(days)] as never[],
      )) as unknown as Array<{ operation_type: string; n: number }>;
      usage = Object.fromEntries(rows.map((r) => [r.operation_type, Number(r.n)]));
    } catch (e) {
      warnings.push(`base illisible (${(e as Error).message}) : analyse statique`);
      storedSteps = null; usage = null;
    }
  } else {
    warnings.push('DATABASE_URL absente : analyse statique, contrôles en base « à vérifier »');
  }

  const report = computeCutover({
    operations: Object.values(AI_OPERATIONS),
    isTarget: isTargetArchitectureOperation,
    promptFiles,
    legacyTemplates,
    storedSteps,
    retiredVariables: retiredVariablesSet(process.env).map((v) => v.name),
    usage,
    days,
  });

  if (args.includes('--json')) console.log(JSON.stringify({ ...report, warnings }, null, 2));
  else print(report, warnings);
  // Strict par défaut : contrôle bloquant ⇒ sortie 1 ; `--report` pour un rapport en 0.
  process.exit(!report.ready && !args.includes('--report') ? 1 : 0);
}

function print(r: CutoverReport, warnings: string[]) {
  console.log(`[ai:cutover-check] garde de l'architecture cible · mode ${r.mode} · fenêtre ${r.days} j`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  const icone = { ok: '✓', bloquant: '✗', avertissement: '!', 'à vérifier': '?' } as const;
  for (const c of r.checks) console.log(`  ${icone[c.status]} ${c.code} — ${c.detail}`);
  console.log(`\nArchitecture cible ${r.ready ? 'RESPECTÉE' : 'NON RESPECTÉE'} (aucune opération dépréciée attendue).`);
}

main().catch((e) => { console.error('[ai:cutover-check]', e); process.exit(1); });
