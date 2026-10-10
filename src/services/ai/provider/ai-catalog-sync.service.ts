/**
 * Synchronisation du catalogue IA — lot 35B, ticket « Catalogue IA dynamique
 * Google : modèles, tarifs, Preview et alertes BO ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE FONCTION MÉTIER
 *
 * `syncAiCatalog` est appelée À L'IDENTIQUE par :
 *   · la tâche planifiée interne `ai-catalog-sync` (toutes les 6 h) ;
 *   · le bouton « Actualiser le catalogue » (Fournisseur IA) ;
 * il n'existe pas deux implémentations. Elle enchaîne :
 *   1. catalogue modèles : `GET /v1beta/models` avec la clé active —
 *      découverte, statut fournisseur, disparition (`refreshModelCatalog`) ;
 *   2. qualification technique automatique des modèles listés jamais (ou
 *      plus récemment) qualifiés, hors expérimentaux — bornée par passage ;
 *   3. statut opérationnel : génération minimale des modèles déjà
 *      utilisables (registre ou qualifiés) ;
 *   4. catalogue tarifaire : page officielle Google (`syncPricingCatalog`) —
 *      indépendant : une panne de la source tarifaire n'empêche rien ;
 *   5. baseline du bandeau à la première synchronisation réussie ;
 *   6. modèles actifs devenus inutilisables : alerte d'exploitation, sans
 *      jamais modifier la configuration.
 *
 * Un passage à la fois (bail `ai-catalog-sync`, partagé entre instances) ;
 * un second déclenchement pendant un passage rend `skipped`. Ne lève pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { ListedModel } from './model-catalog.service';
import type { QualificationCall } from './model-qualification.service';
import type { PricingSyncDeps, PricingSyncResult } from '../gateway/pricing/pricing-sync.service';
import type { ActiveModelAnomaly } from './active-model-anomalies';

export type SyncTrigger = 'schedule' | 'manual' | 'startup';

export interface AiCatalogSyncResult {
  ok: boolean;
  skipped?: boolean;
  trigger: SyncTrigger;
  catalog: { ok: boolean; modelsSeen: number; discovered: string[]; disappeared: string[]; error?: string };
  qualification: { qualified: string[]; failed: string[]; inconclusive: string[]; remaining: number };
  operational: { probed: number; failed: string[] };
  pricing: Pick<PricingSyncResult, 'status' | 'sourceRead' | 'error'> & { known: number; unknown: number; changed: number };
  baseline: boolean;
  anomalies: ActiveModelAnomaly[];
}

export interface AiCatalogSyncDeps {
  fetcher?: typeof fetch;
  qualificationCall?: QualificationCall;
  probeCall?: (model: string) => Promise<{ rawText: string; inputTokens?: number; outputTokens?: number }>;
  pricing?: PricingSyncDeps;
  /**
   * Qualifications au plus par passage (défaut : 12 pour la tâche planifiée,
   * 4 pour le bouton — la requête HTTP doit rester courte ; le reste est
   * qualifié au passage planifié suivant).
   */
  maxQualifications?: number;
  /** Budget de la phase de qualification, en ms (défaut : 8 min planifié, 20 s bouton). */
  qualificationBudgetMs?: number;
  /** Bail inter-instances ; injecté en test. `null` : passage déjà en cours. */
  lock?: () => Promise<{ release: () => Promise<void> } | null>;
  now?: () => Date;
}

const LOCK = 'ai-catalog-sync';
const LOCK_TTL_MS = 20 * 60_000;
const MAX_PROBES = 25;

async function defaultLock(): Promise<{ release: () => Promise<void> } | null> {
  try {
    const { acquireJobLock, releaseJobLock } = await import('@/lib/job-lock');
    const h = await acquireJobLock(LOCK, LOCK_TTL_MS);
    return h ? { release: () => releaseJobLock(h) } : null;
  } catch {
    // Table des baux illisible : on n'empêche pas la synchronisation.
    return { release: async () => undefined };
  }
}

/**
 * Ordre de qualification : modèles découverts à ce passage (ceux qu'on
 * attend), modèles des configurations actives (déjà utilisables par leur
 * qualification historique), registre, puis les autres (identifiants les plus
 * récents d'abord). Les expérimentaux ne sont jamais qualifiés.
 */
export function qualificationOrder(
  listed: readonly Pick<ListedModel, 'model' | 'lifecycle'>[],
  priority: { active: ReadonlySet<string>; declared: ReadonlySet<string>; discovered?: ReadonlySet<string> },
): string[] {
  const rang = (m: string) => (priority.discovered?.has(m) ? 0 : priority.active.has(m) ? 1 : priority.declared.has(m) ? 2 : 3);
  return listed
    .filter((m) => m.lifecycle !== 'experimental')
    .map((m) => m.model)
    .sort((a, b) => rang(a) - rang(b) || b.localeCompare(a));
}

export async function syncAiCatalog(
  opts: { trigger: SyncTrigger; userId?: number | null },
  deps: AiCatalogSyncDeps = {},
): Promise<AiCatalogSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: AiCatalogSyncResult = {
    ok: false, trigger: opts.trigger,
    catalog: { ok: false, modelsSeen: 0, discovered: [], disappeared: [] },
    qualification: { qualified: [], failed: [], inconclusive: [], remaining: 0 },
    operational: { probed: 0, failed: [] },
    pricing: { status: 'skipped', sourceRead: false, known: 0, unknown: 0, changed: 0 },
    baseline: false,
    anomalies: [],
  };
  const bail = await (deps.lock ?? defaultLock)();
  if (!bail) return { ...result, skipped: true };

  try {
    // 1. Catalogue modèles.
    const { refreshModelCatalog } = await import('./model-catalog.service');
    const cat = await refreshModelCatalog(opts.userId ?? null, deps.fetcher ?? fetch).catch((e): Awaited<ReturnType<typeof refreshModelCatalog>> => ({
      ok: false, modelsSeen: 0, disappeared: [], error: (e as Error).message,
    }));
    result.catalog = {
      ok: cat.ok, modelsSeen: cat.modelsSeen, discovered: cat.discovered ?? [], disappeared: cat.disappeared,
      ...(cat.error ? { error: cat.error } : {}),
    };

    const { getProviderSecret } = await import('./provider-secret');
    const secret = await getProviderSecret('gemini').catch(() => null);

    if (cat.ok && secret && cat.listed?.length) {
      // 2. Qualification automatique.
      const [Q, { DECLARED_MODELS }, { loadActiveChains }, { recordOperationalStatus, probeModels }, { thinkingConfigFor }] = await Promise.all([
        import('./model-qualification.service'), import('../registry/models'), import('./active-model-anomalies'),
        import('./model-operational.service'), import('../gateway/providers/gemini-generation-config'),
      ]);
      const stored = await Q.loadQualifications(secret);
      const actifs = new Set((await loadActiveChains().catch(() => [])).map((c) => c.model));
      const declares = new Set(DECLARED_MODELS.map((m) => m.model));
      const aQualifier = qualificationOrder(cat.listed, { active: actifs, declared: declares, discovered: new Set(cat.discovered ?? []) })
        .filter((m) => Q.needsQualification(stored.get(m), now));
      const manuel = opts.trigger === 'manual';
      const max = deps.maxQualifications ?? (manuel ? 4 : 12);
      const finBudget = Date.now() + (deps.qualificationBudgetMs ?? (manuel ? 20_000 : 8 * 60_000));
      const call = deps.qualificationCall ?? Q.defaultQualificationCall();
      const parModele = new Map(cat.listed.map((m) => [m.model, m]));
      const qualifiesIci = new Set<string>();
      const lot = aQualifier.slice(0, max);
      let traites = 0;
      // Par paquets de 4 modèles en parallèle (épreuves d'un modèle en série) ;
      // arrêt au budget : le reste attend le passage suivant.
      for (let i = 0; i < lot.length && Date.now() < finBudget; i += 4) {
        const paquet = lot.slice(i, i + 4);
        traites += paquet.length;
        const resultats = await Promise.all(paquet.map(async (model) => ({
          model,
          r: await Q.qualifyModel(model, call, {
            secret, supportsThinking: parModele.get(model)?.supportsThinking ?? null,
            thinkingConfigured: (m) => thinkingConfigFor(m, 'étendu') !== undefined,
          }),
        })));
        for (const { model, r } of resultats) {
          if (r.generate === null) { result.qualification.inconclusive.push(model); continue; }
          await Q.recordQualification(model, secret, r);
          await recordOperationalStatus({ model, secret, ok: r.generate, error: r.errors.generate ?? null, source: 'catalog_refresh' });
          qualifiesIci.add(model);
          (r.generate && r.structured !== false ? result.qualification.qualified : result.qualification.failed).push(model);
        }
      }
      result.qualification.remaining = Math.max(0, aQualifier.length - traites);

      // 3. Statut opérationnel des modèles déjà utilisables.
      const apres = await Q.loadQualifications(secret);
      const aSonder = cat.listed.map((m) => m.model)
        .filter((m) => !qualifiesIci.has(m) && (declares.has(m) || apres.get(m)?.generate))
        .sort((a, b) => Number(actifs.has(b)) - Number(actifs.has(a)))
        .slice(0, MAX_PROBES);
      if (aSonder.length > 0) {
        const probes = await probeModels(aSonder, secret, deps.probeCall ? { call: deps.probeCall } : {});
        result.operational = { probed: probes.length, failed: probes.filter((p) => !p.ok && !p.transient).map((p) => p.model) };
      }
    }

    // 4. Catalogue tarifaire (indépendant du catalogue modèles).
    try {
      const [{ syncPricingCatalog }, { modelsToPrice }] = await Promise.all([
        import('../gateway/pricing/pricing-sync.service'), import('../gateway/pricing/refresh-pricing.job'),
      ]);
      const p = await syncPricingCatalog(await modelsToPrice(), deps.pricing ?? {});
      result.pricing = { status: p.status, sourceRead: p.sourceRead, known: p.known.length, unknown: p.unknown.length, changed: p.changed.length, ...(p.error ? { error: p.error } : {}) };
    } catch (e) {
      result.pricing = { status: 'failed', sourceRead: false, known: 0, unknown: 0, changed: 0, error: (e as Error).message };
    }

    // 5. Baseline du bandeau.
    if (cat.ok) {
      const { ensureBaseline } = await import('./new-models.service');
      result.baseline = await ensureBaseline();
    }

    // 6. Modèles actifs devenus inutilisables : alerte, jamais de remplacement.
    try {
      const [{ loadUsableModelsContext }, A] = await Promise.all([
        import('../registry/usable-models'), import('./active-model-anomalies'),
      ]);
      const ctx = await loadUsableModelsContext();
      result.anomalies = A.detectActiveModelAnomalies(await A.loadActiveChains(), ctx);
      await A.raiseActiveModelAlerts(result.anomalies, now);
    } catch (e) {
      console.warn('[ai-catalog-sync] contrôle des modèles actifs impossible :', (e as Error).message);
    }

    result.ok = cat.ok;
    await pgClient.unsafe(
      `UPDATE ai_model_catalog_refresh SET last_sync_at = NOW(), last_sync_trigger = $1, last_sync_summary = $2::jsonb
        WHERE provider = 'gemini'`,
      [opts.trigger, JSON.stringify(summaryOf(result))] as never[],
    ).catch(() => undefined);
    console.info(`[ai-catalog-sync] ${opts.trigger} : ${JSON.stringify(summaryOf(result))}`);
    return result;
  } finally {
    await bail.release().catch(() => undefined);
  }
}

/** Résumé compact (journal, note de tâche, BO). */
export function summaryOf(r: AiCatalogSyncResult): Record<string, unknown> {
  return {
    catalog: r.catalog.ok ? { seen: r.catalog.modelsSeen, new: r.catalog.discovered, gone: r.catalog.disappeared } : { error: r.catalog.error },
    qualified: r.qualification.qualified, failed: r.qualification.failed,
    ...(r.qualification.inconclusive.length ? { inconclusive: r.qualification.inconclusive } : {}),
    ...(r.qualification.remaining ? { remaining: r.qualification.remaining } : {}),
    probed: r.operational.probed, notOperational: r.operational.failed,
    pricing: { status: r.pricing.status, known: r.pricing.known, unknown: r.pricing.unknown, changed: r.pricing.changed, ...(r.pricing.error ? { error: r.pricing.error } : {}) },
    ...(r.baseline ? { baseline: true } : {}),
    anomalies: r.anomalies.map((a) => `${a.treatment}/${a.rank}/${a.model}`),
  };
}
