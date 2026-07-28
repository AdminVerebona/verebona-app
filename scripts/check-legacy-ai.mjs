#!/usr/bin/env node
/**
 * Contrôle CI anti-réintroduction — CDC §8.1 et §12, critère 23.
 *
 * « Une recherche automatisée dans le dépôt et une règle de CI doivent empêcher
 *   la réintroduction des anciens clients, identifiants d'usage, routes et
 *   services supprimés. »
 *
 * Sortie 0 : conforme. Sortie 1 : au moins un composant historique réapparaît.
 *
 * Utilisation : node scripts/check-legacy-ai.mjs [--phase=1|2|3|4|5|6|7]
 * La phase correspond au lot en cours : les règles se durcissent lot après lot,
 * ce qui permet d'activer le contrôle dès le lot 1 sans bloquer le chantier.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
const PHASE = phaseArg ? Number(phaseArg.split('=')[1]) : 7;

/** Chemins autorisés à importer le SDK fournisseur (CDC §12, critère 4). */
const SDK_ALLOWLIST = ['src/services/ai/gateway/providers/'];

/** Fichiers dont l'existence est interdite à partir du lot indiqué. */
const FORBIDDEN_FILES = [
  { path: 'src/services/document-ai/prompts/intent_detect_v1.txt',   fromPhase: 1, reason: 'prompt orphelin' },
  { path: 'src/services/document-ai/prompts/title_coherence_v1.txt', fromPhase: 1, reason: 'prompt orphelin' },
  { path: 'src/app/api/assets/[id]/ai-suggestions/route.ts',    fromPhase: 3, reason: 'usage 3 — suggestions à la demande' },
  { path: 'src/services/document-ai/apply-ai-suggestions.ts',   fromPhase: 3, reason: 'usages 3 et 4' },
  { path: 'src/services/document-ai/enrich-and-coherence.service.ts', fromPhase: 3, reason: 'usage 5' },
  { path: 'src/lib/gemini-search.ts',                           fromPhase: 5, reason: 'usage 6 — recherche sémantique' },
  { path: 'src/lib/intelligent-search.ts',                      fromPhase: 5, reason: 'usage 7 — réponse générative' },
  { path: 'src/app/api/search/intelligent/route.ts',            fromPhase: 5, reason: 'usage 7' },
  { path: 'src/services/agenda/AgendaClassificationService.ts', fromPhase: 4, reason: 'usage 8' },
  { path: 'src/app/api/admin/ai-instructions/apply/route.ts',   fromPhase: 6, reason: 'usage 11 — application directe des patchs' },
  { path: 'src/services/document-ai/gemini-client.ts',          fromPhase: 7, reason: 'couche modèles historique' },
  { path: 'src/services/document-ai/upload-to-gemini.ts',       fromPhase: 7, reason: 'Files API hors gateway' },
  { path: 'src/services/document-ai/unified-analysis-pipeline.ts', fromPhase: 7, reason: 'orchestrateur historique' },
];

/** Symboles dont la réapparition dans le code est interdite. */
const FORBIDDEN_SYMBOLS = [
  { pattern: /\bapplyAiSuggestionsToAsset\b/, fromPhase: 3, reason: 'moteur de complétion des champs vides' },
  { pattern: /\benrichAndCheckCoherence\b/,   fromPhase: 3, reason: 'moteur de cohérence historique' },
  { pattern: /\bgeminiSearch\b/,              fromPhase: 5, reason: 'recherche sémantique historique' },
  { pattern: /\bintelligentSearch\b/,         fromPhase: 5, reason: 'réponse générative historique' },
  { pattern: /\bcallGeminiWithFallback\b/,    fromPhase: 7, reason: 'client modèle historique' },
  { pattern: /\bDEFAULT_PROVIDER_ROUTING\b/,  fromPhase: 6, reason: 'routage historique incohérent (défaut n°10)' },
  { pattern: /\bwriteFileSync\s*\([^)]*prompts?/i, fromPhase: 6, reason: 'écriture directe dans un prompt actif (CDC §4.5.3)' },
];

const errors = [];
const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.history']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) files.push(full);
  }
  return files;
}

// ── 1. Aucune instanciation du SDK hors adaptateur (critère 4) ───────────────
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (SDK_ALLOWLIST.some((p) => rel.startsWith(p))) continue;

  const content = readFileSync(file, 'utf8');
  if (/@google\/generative-ai/.test(content) || /new\s+GoogleGenerativeAI/.test(content)) {
    errors.push(`[critère 4] ${rel} accède directement au SDK fournisseur. Passez par AiGateway.`);
  }

  for (const s of FORBIDDEN_SYMBOLS) {
    if (PHASE >= s.fromPhase && s.pattern.test(content)) {
      errors.push(`[lot ${s.fromPhase}] ${rel} référence un composant supprimé (${s.reason}).`);
    }
  }
}

// ── 2. Aucun fichier historique ne doit subsister ────────────────────────────
for (const f of FORBIDDEN_FILES) {
  if (PHASE >= f.fromPhase && existsSync(join(ROOT, f.path))) {
    errors.push(`[lot ${f.fromPhase}] ${f.path} existe encore (${f.reason}).`);
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error(`\n✖ ${errors.length} violation(s) détectée(s) — phase ${PHASE} :\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error('\nCDC §12 : « La présence d\'un seul ancien moteur encore accessible en');
  console.error('production empêche la clôture du chantier. »\n');
  process.exit(1);
}

console.log(`✓ Aucun composant IA historique détecté (phase ${PHASE}).`);
