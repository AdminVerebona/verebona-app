/**
 * Lot 100B — HARNAIS des scénarios de stress (catégorie E2E_MÉTIER, ticket
 * #601 : 15 scénarios distincts des 401 cas, exécutés en E2E avec données
 * PERSISTÉES : liens, opérations, agenda, cohérence, effets d'écran).
 *
 * Un scénario = mise en place (données réelles en base de test), étapes
 * (services de PRODUCTION, modèle simulé par rejeu), assertions sur l'ÉTAT
 * FINAL persisté. Chaque assertion déclare sa COUCHE (données, serveur, IA,
 * écran) : un défaut serveur n'est jamais attribué artificiellement à une
 * réponse IA ; une étape qui lève une erreur est un défaut de la couche
 * SERVEUR (le rapport le dit).
 *
 * Les 15 spécifications du ZIP sont importées dans `corpus-601/stress/`
 * (`importer.ts`) ; chacune devient un scénario en l'enregistrant dans un
 * fichier `src/test/e2e/scenarios/l100b-stress-*.e2e.ts` avec
 * `runStressScenario` (exemples génériques : `l100b-stress-e2e-metier.e2e.ts`).
 * Une spécification sans scénario écrit reste listée « à écrire », jamais
 * verte (`stressCoverage`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './manifest';
import type { CorpusManifest } from './model';

export type StressLayer = 'DONNEES' | 'SERVEUR' | 'IA' | 'ECRAN';

export interface StressScenario<C> {
  id: string;
  title: string;
  /** Spécification #601 couverte (identifiant du manifeste), si importée. */
  manifestId?: string | null;
  setup(ctx: C): Promise<void>;
  steps: Array<{ label: string; run(ctx: C): Promise<void> }>;
  /** Assertion sur l'état final : rend null si conforme, sinon le constat. */
  assertions: Array<{ label: string; layer: StressLayer; check(ctx: C): Promise<string | null> }>;
}

export interface StressReport {
  id: string;
  title: string;
  manifestId: string | null;
  passed: boolean;
  steps: Array<{ label: string; ok: boolean; error: string | null; layer: StressLayer | null }>;
  assertions: Array<{ label: string; layer: StressLayer; ok: boolean; detail: string | null }>;
  durationMs: number;
}

/** Exécute un scénario de stress ; une étape en erreur arrête le scénario (défaut SERVEUR, assertions non évaluées). */
export async function runStressScenario<C>(s: StressScenario<C>, ctx: C): Promise<StressReport> {
  const t0 = Date.now();
  const steps: StressReport['steps'] = [];
  const assertions: StressReport['assertions'] = [];
  let arret = false;
  try { await s.setup(ctx); steps.push({ label: 'mise en place des données', ok: true, error: null, layer: null }); } catch (e) {
    steps.push({ label: 'mise en place des données', ok: false, error: (e as Error).message.slice(0, 500), layer: 'DONNEES' });
    arret = true;
  }
  for (const st of s.steps) {
    if (arret) { steps.push({ label: st.label, ok: false, error: 'non exécutée (étape précédente en erreur)', layer: null }); continue; }
    try { await st.run(ctx); steps.push({ label: st.label, ok: true, error: null, layer: null }); } catch (e) {
      steps.push({ label: st.label, ok: false, error: (e as Error).message.slice(0, 500), layer: 'SERVEUR' });
      arret = true;
    }
  }
  for (const a of s.assertions) {
    if (arret) { assertions.push({ label: a.label, layer: a.layer, ok: false, detail: 'non évaluée : scénario interrompu' }); continue; }
    try {
      const d = await a.check(ctx);
      assertions.push({ label: a.label, layer: a.layer, ok: d === null, detail: d });
    } catch (e) {
      assertions.push({ label: a.label, layer: 'SERVEUR', ok: false, detail: `contrôle en erreur : ${(e as Error).message.slice(0, 300)}` });
    }
  }
  return {
    id: s.id, title: s.title, manifestId: s.manifestId ?? null, durationMs: Date.now() - t0,
    passed: steps.every((x) => x.ok) && assertions.every((x) => x.ok), steps, assertions,
  };
}

/** Rapport lisible (CI, recette). */
export function stressReportText(r: StressReport): string {
  return [
    `${r.passed ? 'RÉUSSI' : 'ÉCHEC'} — ${r.id} ${r.title} (${r.durationMs} ms)${r.manifestId ? ` · spécification ${r.manifestId}` : ''}`,
    ...r.steps.map((s) => `  étape ${s.ok ? '✓' : '✗'} ${s.label}${s.error ? ` — ${s.layer ?? ''} ${s.error}` : ''}`),
    ...r.assertions.map((a) => `  [${a.layer}] ${a.ok ? '✓' : '✗'} ${a.label}${a.detail ? ` — ${a.detail}` : ''}`),
  ].join('\n');
}

/** Spécifications de stress importées (`corpus-601/stress/*.json`). */
export function importedStressSpecs(): Array<{ id: string; title: string; file: string }> {
  const dir = join(REPO_ROOT, 'src', 'services', 'ai', 'governance', 'master-corpus', 'corpus-601', 'stress');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string; title?: string; description?: string };
    return { id: String(j.id ?? f), title: String(j.title ?? j.description ?? ''), file: f };
  });
}

/**
 * Couverture des stress (pure) : chaque spécification E2E_MÉTIER du manifeste
 * doit avoir un scénario EXÉCUTABLE déclaré (identifiants des scénarios
 * écrits) ; sinon « à écrire », jamais compté vert.
 */
export function stressCoverage(manifest: CorpusManifest, implemented: readonly string[]): Array<{ id: string; implemented: boolean; reason: string }> {
  return manifest.entries.filter((e) => e.status === 'E2E_METIER').map((e) => ({
    id: e.id, implemented: implemented.includes(e.id),
    reason: implemented.includes(e.id) ? 'scénario E2E écrit (données persistées)' : 'spécification reçue : scénario E2E à écrire avec le harnais (jamais compté vert)',
  }));
}
