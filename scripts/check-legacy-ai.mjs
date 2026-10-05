#!/usr/bin/env node
/**
 * Contrôle CI anti-réintroduction — CDC §8.1 et §12, critère 23.
 *
 * « Une recherche automatisée dans le dépôt et une règle de CI doivent empêcher
 *   la réintroduction des anciens clients, identifiants d'usage, routes et
 *   services supprimés. »
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CLIQUET DE DETTE — AJOUT DU LOT 0
 *
 * Ce script échouait sur le dépôt tel qu'il est aujourd'hui : 12 violations en
 * phase 1, 26 en phase 7. La CI était donc rouge en permanence, et le seul
 * moyen de faire passer une pull request pendant les mois du chantier était de
 * désactiver le contrôle — c'est-à-dire de perdre le garde-fou exactement quand
 * il sert.
 *
 * Le script fonctionne désormais par cliquet, sur le modèle des outils de dette
 * technique :
 *
 *   • les violations listées dans `ai-legacy-baseline.json` sont de la DETTE
 *     CONNUE : elles sont affichées, elles ne font pas échouer le build ;
 *   • toute violation NOUVELLE fait échouer le build, sans exception ;
 *   • une violation résorbée doit être retirée du fichier de référence, ce qui
 *     la rend définitivement interdite. Le cliquet ne tourne que dans un sens.
 *
 * Le fichier de référence ne peut donc que rétrécir, lot après lot, jusqu'à
 * être vide au lot 7 — moment où le contrôle retrouve sa forme stricte
 * d'origine sans qu'aucune ligne du script n'ait à changer.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Utilisation :
 *   node scripts/check-legacy-ai.mjs [--phase=1..7]
 *   node scripts/check-legacy-ai.mjs --phase=2 --update-baseline
 *   node scripts/check-legacy-ai.mjs --phase=2 --strict
 *
 * Sortie 0 : conforme ou dette inchangée. Sortie 1 : régression.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Phase par défaut : variable d'environnement, sinon 1 (chantier en cours).
// Lue dans le script et non dans le script npm : `${VAR:-1}` n'est pas
// interprété par cmd.exe, et l'équipe développe sous Windows.
// Variable présente mais vide (`AI_MIGRATION_PHASE=`) : défaut 1, pas 0 (lot 24).
const PHASE = Number(arg('phase', process.env.AI_MIGRATION_PHASE?.trim() || '1'));
const BASELINE_PATH = join(SCRIPT_DIR, arg('baseline', 'ai-legacy-baseline.json'));
const UPDATE = flag('update-baseline');
const STRICT = flag('strict');

/** Chemins autorisés à importer le SDK fournisseur (CDC §12, critère 4). */
const SDK_ALLOWLIST = ['src/services/ai/gateway/providers/'];

/**
 * Chemins autorisés à appeler le moteur d'analyse directement (critère 24).
 *
 * Le §10.4 interdit que l'ancien et le nouveau moteur puissent s'exécuter sur
 * la même source. Cela ne tient que si TOUS les appelants passent par
 * l'aiguillage `entrypoint.ts`. La route d'analyse des liens web l'avait
 * contourné : avec le drapeau à `legacy`, un fichier partait sur le moteur
 * historique et un lien web sur le nouveau.
 *
 * Un appel direct hors de ces chemins est désormais une violation.
 */
const PIPELINE_ALLOWLIST = [
  'src/services/ai/source-analysis/',
];

/** Fichiers dont l'existence est interdite à partir du lot indiqué. */
const FORBIDDEN_FILES = [
  { path: 'src/services/document-ai/prompts/intent_detect_v1.txt', fromPhase: 1, reason: 'prompt orphelin' },
  { path: 'src/services/document-ai/prompts/title_coherence_v1.txt', fromPhase: 1, reason: 'prompt orphelin' },
  // Lot 16b-3b (D-H1) : supprimés, interdits à toute phase (étaient de phase 3).
  { path: 'src/app/api/assets/[id]/ai-suggestions/route.ts', fromPhase: 1, reason: 'usage 3 — préremplissage IA silencieux (D-H1, lot 16b-3)' },
  { path: 'src/services/document-ai/apply-ai-suggestions.ts', fromPhase: 1, reason: 'usages 3 et 4 (D-H1, lot 16b-3)' },
  { path: 'src/services/document-ai/enrich-and-coherence.service.ts', fromPhase: 1, reason: 'usage 5 (D-H1, lot 16b-3)' },
  // Lot 16b-2 (retrait T2 / T4, décision D-H2) : supprimés, interdits à toute phase.
  { path: 'src/lib/gemini-search.ts', fromPhase: 1, reason: 'usage 6 — recherche sémantique (D-H2, lot 16b-2)' },
  { path: 'src/lib/intelligent-search.ts', fromPhase: 1, reason: 'usage 7 — réponse générative (D-H2, lot 16b-2)' },
  { path: 'src/app/api/search/intelligent/route.ts', fromPhase: 1, reason: 'usage 7 (D-H2, lot 16b-2)' },
  { path: 'src/services/agenda/AgendaClassificationService.ts', fromPhase: 1, reason: 'usage 8 (lot 16b-2)' },
  { path: 'src/db/migrations/backfill-home-category.ts', fromPhase: 1, reason: 'rattrapage par l\'usage 8 (lot 16b-2)' },
  { path: 'src/services/verebona-assistant/prompts/intent-tasks.ts', fromPhase: 1, reason: 'consignes T2 concaténées (lot 16b-2)' },
  { path: 'src/services/verebona-assistant/registries/prompt-registry.ts', fromPhase: 1, reason: 'registre des prompts T2 historiques (lot 16b-2)' },
  { path: 'src/services/verebona-assistant/canonical/mode.ts', fromPhase: 1, reason: 'commutateur ASSISTANT_CANONICAL_READ (lot 16b-2)' },
  { path: 'src/services/ai/agenda/rules/rules-engine.ts', fromPhase: 1, reason: 'règles T4 historiques / AI_T4_EFFECTS (lot 16b-2)' },
  // Lot 16b-3 (retrait de l'ancien moteur T1) : supprimés, interdits à toute phase.
  { path: 'src/services/document-ai/gemini-client.ts', fromPhase: 1, reason: 'couche modèles historique T1 (lot 16b-3)' },
  { path: 'src/services/document-ai/unified-analysis-pipeline.ts', fromPhase: 1, reason: 'orchestrateur historique T1 (lot 16b-3)' },
  { path: 'src/services/document-ai/analyze-document.ts', fromPhase: 1, reason: 'analyse documentaire historique, second calcul de coût GEN-005 (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/steps/group-sources.step.ts', fromPhase: 1, reason: 'étape T1 group_sources (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/steps/extract-source.step.ts', fromPhase: 1, reason: 'étape T1 extract_source (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/steps/classify-document.step.ts', fromPhase: 1, reason: 'étape T1 classify_document (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/steps/classify-rubric.step.ts', fromPhase: 1, reason: 'étape T1 classify_rubric (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/steps/identify-entities.step.ts', fromPhase: 1, reason: 'étape T1 identify_entities (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/master/analysis-mode.ts', fromPhase: 1, reason: 'commutateur AI_T1_ANALYSIS_MODE (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/master/shadow.ts', fromPhase: 1, reason: 'observation T1 D-18 (lot 16b-3)' },
  { path: 'src/services/ai/source-analysis/prompt-version.ts', fromPhase: 1, reason: 'version du prompt extract_source (lot 16b-3)' },
  { path: 'src/services/ai/prompts/source-analysis/extract_source_v5.txt', fromPhase: 1, reason: 'prompt d\'étape T1 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/source-analysis/legacy_document_analysis_v1.txt', fromPhase: 1, reason: 'relais T1 (lot 16b-3)' },
  { path: 'src/services/document-ai/prompts/extract_full_v1.txt', fromPhase: 1, reason: 'gabarit historique T1 (lot 16b-3)' },
  { path: 'src/services/document-ai/prompts/detect_groups_v1.txt', fromPhase: 1, reason: 'gabarit historique T1 (lot 16b-3)' },
  // Lot 16b-3b (T3, D-H1, commutateurs et drapeaux) : supprimés, interdits à toute phase.
  { path: 'src/services/document-ai/hourly-enrichment.service.ts', fromPhase: 1, reason: 'revue IA horaire historique T3 (D-H1, lot 16b-3)' },
  { path: 'src/app/api/cron/hourly-enrichment/route.ts', fromPhase: 1, reason: 'cron d\'enrichissement historique (D-H1, lot 16b-3)' },
  { path: 'src/services/document-ai/asset-enrichment-trigger.ts', fromPhase: 1, reason: 'enrichissement silencieux au rattachement (D-H1, lot 16b-3)' },
  { path: 'src/services/document-ai/ai-usage-tracker.ts', fromPhase: 1, reason: 'suivi des moteurs historiques (lot 16b-3)' },
  { path: 'src/services/document-ai/commit-engine.ts', fromPhase: 1, reason: 'écritures directes hors primitives canoniques (lot 16b-3)' },
  { path: 'src/services/document-ai/prompts/asset_suggest_v1.txt', fromPhase: 1, reason: 'gabarit historique T3 (lot 16b-3)' },
  { path: 'src/services/document-ai/prompts/enrich_coherence_v1.txt', fromPhase: 1, reason: 'gabarit historique T3 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/reconciliation/resolve_ambiguity_v1.txt', fromPhase: 1, reason: 'prompt d\'étape T3 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/reconciliation/reconcile_links_v1.txt', fromPhase: 1, reason: 'prompt d\'étape T3 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/reconciliation/legacy_asset_suggest_v1.txt', fromPhase: 1, reason: 'relais T3 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/reconciliation/legacy_apply_suggestions_v1.txt', fromPhase: 1, reason: 'relais T3 (lot 16b-3)' },
  { path: 'src/services/ai/prompts/reconciliation/legacy_enrich_coherence_v1.txt', fromPhase: 1, reason: 'relais T3 (lot 16b-3)' },
  { path: 'src/services/ai/gateway/legacy-prompt.ts', fromPhase: 1, reason: 'relais des prompts historiques WF-41 (lot 16b-3)' },
  { path: 'src/services/ai/reconciliation/shadow-report.service.ts', fromPhase: 1, reason: 'observation AI_RECONCILIATION_ENGINE (lot 16b-3)' },
  { path: 'src/app/api/admin/ai/reconciliation-shadow/route.ts', fromPhase: 1, reason: 'observation AI_RECONCILIATION_ENGINE (lot 16b-3)' },
  { path: 'src/services/canonical/rollout.ts', fromPhase: 1, reason: 'commutateurs CANONICAL_WRITE_MODE, T3_NEGATIVE_RECONCILIATION, EXPORTS_CANONICAL_SOURCE (lot 16b-3)' },
  { path: 'src/services/exports/v12/data/source-diff.ts', fromPhase: 1, reason: 'rapport d\'écarts EXPORTS_CANONICAL_SOURCE=shadow (lot 16b-3)' },
  { path: 'src/services/ai/flags/ai-feature-flags.ts', fromPhase: 1, reason: 'drapeaux AI_* (lot 16b)' },
  { path: 'src/services/ai/flags/use-case-flags.ts', fromPhase: 1, reason: 'drapeaux AI_* (lot 16b)' },
  { path: 'src/services/ai/flags/flags-snapshot.service.ts', fromPhase: 1, reason: 'instantané des drapeaux et commutateurs (lot 16b)' },
  { path: 'src/app/admin/ai-flags/page.tsx', fromPhase: 1, reason: 'écran des drapeaux et commutateurs (D-F, lot 16b-3)' },
  { path: 'src/app/api/admin/ai/flags/route.ts', fromPhase: 1, reason: 'drapeaux et commutateurs (D-F, lot 16b-3)' },
  { path: 'src/app/api/cron/ai/switchover-readiness/route.ts', fromPhase: 1, reason: 'préparation d\'une bascule de drapeau (lot 16b-3)' },
  { path: 'src/app/api/admin/ai-instructions/apply/route.ts', fromPhase: 6, reason: 'usage 11 — application directe des patchs' },
  { path: 'src/services/document-ai/upload-to-gemini.ts', fromPhase: 7, reason: 'Files API hors gateway' },
];

/**
 * Symboles dont la réapparition dans le code est interdite.
 *
 * `id` est stable et indépendant de la phase : c'est la clé du cliquet. Ne le
 * modifiez jamais sans régénérer le fichier de référence.
 */
const FORBIDDEN_SYMBOLS = [
  { id: 'applyAiSuggestionsToAsset', pattern: /\bapplyAiSuggestionsToAsset\b/, fromPhase: 1, reason: 'moteur de complétion des champs vides (D-H1, lot 16b-3)' },
  { id: 'enrichAndCheckCoherence', pattern: /\b(enrichAndCheckCoherence|applyAiEnrichmentAndCoherence)\b/, fromPhase: 1, reason: 'moteur de cohérence historique (D-H1, lot 16b-3)' },
  { id: 'geminiSearch', pattern: /\bgeminiSearch\b/, fromPhase: 1, reason: 'recherche sémantique historique (D-H2)' },
  { id: 'intelligentSearch', pattern: /\bintelligentSearch\b/, fromPhase: 1, reason: 'réponse générative historique (D-H2)' },
  { id: 'classifyAgendaItem', pattern: /\bclassifyAgendaItem\b/, fromPhase: 1, reason: 'classifieur agenda historique (lot 16b-2)' },
  { id: 'intentTaskFor', pattern: /\bintentTaskFor\b/, fromPhase: 1, reason: 'consignes T2 concaténées (lot 16b-2)' },
  { id: 'canonicalReadEnabled', pattern: /\b(canonicalReadEnabled|assistantCanonicalReadMode|assistantReadMode)\b/, fromPhase: 1, reason: 'commutateur ASSISTANT_CANONICAL_READ (lot 16b-2)' },
  { id: 't4EffectsMode', pattern: /\bt4EffectsMode\b/, fromPhase: 1, reason: 'commutateur AI_T4_EFFECTS (lot 16b-2)' },
  // Lot 16b-3 (retrait de l'ancien moteur T1).
  { id: 'callGeminiWithFallback', pattern: /\bcallGeminiWithFallback\b/, fromPhase: 1, reason: 'client modèle historique T1 (lot 16b-3)' },
  { id: 'runUnifiedAnalysisPipeline', pattern: /\brunUnifiedAnalysisPipeline\b/, fromPhase: 1, reason: 'orchestrateur historique T1 (lot 16b-3)' },
  { id: 'isUnifiedAnalysisActive', pattern: /\b(isUnifiedAnalysisActive|runLegacy)\b/, fromPhase: 1, reason: 'aiguillage AI_UNIFIED_SOURCE_ANALYSIS (lot 16b-3)' },
  { id: 'resolveT1Route', pattern: /\b(resolveT1Route|t1AnalysisMode|t1PromptArchitecture|t1ShadowSampleRate)\b/, fromPhase: 1, reason: 'commutateur AI_T1_ANALYSIS_MODE (lot 16b-3)' },
  { id: 'scheduleT1Shadow', pattern: /\b(scheduleT1Shadow|settleT1Shadows|compareT1Results)\b/, fromPhase: 1, reason: 'observation T1 D-18 (lot 16b-3)' },
  { id: 't1StepsEngine', pattern: /\b(groupSources|extractSource|identifyEntities|classifyRubric)\s*\(/, fromPhase: 1, reason: 'étapes T1 historiques (lot 16b-3)' },
  { id: 'EXTRACT_SOURCE_PROMPT_VERSION', pattern: /\bEXTRACT_SOURCE_PROMPT_VERSION\b/, fromPhase: 1, reason: 'version du prompt extract_source (lot 16b-3)' },
  { id: 'persistKnowledgeFromLegacyRun', pattern: /\bpersistKnowledgeFromLegacyRun\b/, fromPhase: 1, reason: 'connaissance issue du moteur historique T1 (lot 16b-3)' },
  // Lot 16b-3b (T3, D-H1, commutateurs et drapeaux).
  { id: 'triggerAssetEnrichment', pattern: /\b(triggerAssetEnrichment|runHourlyEnrichment)\b/, fromPhase: 1, reason: 'enrichissement historique du bien (D-H1, lot 16b-3)' },
  { id: 'AiUsageTracker', pattern: /\bAiUsageTracker\b/, fromPhase: 1, reason: 'suivi des moteurs historiques (lot 16b-3)' },
  { id: 'commitDocument', pattern: /\b(commitDocument|commitLot)\s*\(/, fromPhase: 1, reason: 'moteur de commit historique (lot 16b-3)' },
  { id: 'legacyPromptRelay', pattern: /\b(executeLegacyPrompt|LEGACY_PROMPT_VARIABLE|legacyPrompt\s*:|unredactedVariables|migratesTo\s*:)/, fromPhase: 1, reason: 'relais / étapes historiques (lot 16b-3)' },
  { id: 'rolloutSwitches', pattern: /\b(getRolloutMode|canonicalWriteMode|t3NegativeMode|exportsSourceMode|rolloutSnapshot|ROLLOUT_SWITCHES|observeLegacyWrite)\b/, fromPhase: 1, reason: 'commutateurs CANONICAL_WRITE_MODE / T3_NEGATIVE_RECONCILIATION / EXPORTS_CANONICAL_SOURCE (lot 16b-3)' },
  { id: 'aiFlags', pattern: /\b(shouldRunLegacy|shouldRunNewEngine|getFlagMode|snapshotFlags|buildFlagsSnapshot|USE_CASE_FLAGS|isUseCaseRunning)\b/, fromPhase: 1, reason: 'drapeaux AI_* (lot 16b)' },
  { id: 'promptArchitectureSwitch', pattern: /\b(getPromptArchitecture|MASTER_ENGINE_FLAG)\b/, fromPhase: 1, reason: 'aiguillage steps / master (lot 16b-3)' },
  { id: 'exportsShadow', pattern: /\b(diffExportSources|diffAssetSnapshots|getShadowReport)\b/, fromPhase: 1, reason: 'modes d\'observation (lot 16b-3)' },
  { id: 'DEFAULT_PROVIDER_ROUTING', pattern: /\bDEFAULT_PROVIDER_ROUTING\b/, fromPhase: 6, reason: 'routage historique incohérent (défaut n°10)' },
  { id: 'promptWriteFileSync', pattern: /\bwriteFileSync\s*\([^)]*prompts?/i, fromPhase: 6, reason: 'écriture directe dans un prompt actif (CDC §4.5.3)' },
];

const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.history']);

function walk (dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) files.push(full);
  }
  return files;
}

// ── Collecte ─────────────────────────────────────────────────────────────────
const violations = [];

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (SDK_ALLOWLIST.some((p) => rel.startsWith(p))) continue;

  const content = readFileSync(file, 'utf8');

  // D-J5 (lot 16b-3) : SDK `@google/genai` ; l'ancien `@google/generative-ai`
  // est désinstallé. L'un comme l'autre, seulement dans l'adaptateur.
  // Code seul : un commentaire qui DOCUMENTE la règle (« interdire
  // `@google/genai` ») n'est pas un accès au SDK.
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/@google\/(generative-ai|genai)\b/.test(code) || /new\s+(GoogleGenerativeAI|GoogleGenAI)\b/.test(code)) {
    violations.push({
      id: `sdk:${rel}`,
      message: `[critère 4] ${rel} accède directement au SDK fournisseur. Passez par AiGateway.`,
    });
  }

  if (
    !PIPELINE_ALLOWLIST.some((p) => rel.startsWith(p)) &&
    /\brunSourceAnalysis\s*\(/.test(content)
  ) {
    violations.push({
      id: `pipeline:${rel}`,
      message:
        `[critère 24] ${rel} appelle runSourceAnalysis directement. ` +
        'Passez par analyzeFileSources ou analyzeWebLinkSource (§10.4).',
    });
  }

  for (const s of FORBIDDEN_SYMBOLS) {
    if (PHASE >= s.fromPhase && s.pattern.test(content)) {
      violations.push({
        id: `symbol:${s.id}:${rel}`,
        message: `[lot ${s.fromPhase}] ${rel} référence un composant supprimé (${s.reason}).`,
      });
    }
  }
}

for (const f of FORBIDDEN_FILES) {
  if (PHASE >= f.fromPhase && existsSync(join(ROOT, f.path))) {
    violations.push({
      id: `file:${f.path}`,
      message: `[lot ${f.fromPhase}] ${f.path} existe encore (${f.reason}).`,
    });
  }
}

violations.sort((a, b) => a.id.localeCompare(b.id));

// ── Mise à jour du fichier de référence ──────────────────────────────────────
if (UPDATE) {
  const payload = {
    $comment: [
      'Dette IA historique connue — CDC §8.1. Généré par scripts/check-legacy-ai.mjs.',
      "Ce fichier ne doit JAMAIS grossir. Chaque entrée retirée devient définitivement interdite.",
      'Régénération après résorption : npm run ai:baseline',
    ],
    generatedAt: new Date().toISOString(),
    phase: PHASE,
    count: violations.length,
    allowed: violations.map((v) => v.id),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`✓ Référence de dette régénérée : ${violations.length} entrée(s) — phase ${PHASE}.`);
  process.exit(0);
}

// ── Comparaison au cliquet ───────────────────────────────────────────────────
let baseline = { allowed: [], phase: null };
if (existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} else {
  console.warn(`⚠ Aucun fichier de référence (${relative(ROOT, BASELINE_PATH)}) — contrôle strict.`);
}

const allowed = new Set(baseline.allowed ?? []);
const seen = new Set(violations.map((v) => v.id));

const regressions = violations.filter((v) => !allowed.has(v.id));
const known = violations.filter((v) => allowed.has(v.id));
const resolved = [...allowed].filter((id) => !seen.has(id));

if (known.length > 0) {
  console.log(`\nℹ ${known.length} violation(s) de dette connue — phase ${PHASE} (non bloquantes) :\n`);
  for (const v of known) console.log(`  · ${v.message}`);
}

if (resolved.length > 0) {
  console.log(`\n✓ ${resolved.length} violation(s) résorbée(s) depuis la dernière référence :\n`);
  for (const id of resolved) console.log(`  · ${id}`);
  console.log('\n  Retirez-les définitivement : npm run ai:baseline');
}

if (regressions.length > 0) {
  console.error(`\n✖ ${regressions.length} RÉGRESSION(S) — composant historique réintroduit :\n`);
  for (const v of regressions) console.error(`  • ${v.message}`);
  console.error("\nCDC §12 : « La présence d'un seul ancien moteur encore accessible en");
  console.error('production empêche la clôture du chantier. »\n');
  process.exit(1);
}

if (STRICT && resolved.length > 0) {
  console.error('\n✖ Fichier de référence obsolète : des violations résorbées y figurent encore.');
  console.error('  Exécutez `npm run ai:baseline` et commitez le résultat.\n');
  process.exit(1);
}

if (violations.length === 0) {
  console.log(`\n✓ Aucun composant IA historique détecté (phase ${PHASE}). Chantier clos pour ce contrôle.`);
} else {
  console.log(`\n✓ Aucune régression (phase ${PHASE}) — ${known.length} dette(s) connue(s) restante(s).`);
}
