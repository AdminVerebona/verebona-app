/**
 * Synchronisation du catalogue IA — lot 35B, ticket « Catalogue IA dynamique
 * Google : modèles, tarifs, Preview et alertes BO ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE FONCTION MÉTIER
 *
 * `syncAiCatalog` est appelée À L'IDENTIQUE par :
 *   · la tâche planifiée interne `ai-catalog-sync` (lot 85C, CAT-01 : chaque
 *     jour — plus toutes les 6 h) ;
 *   · le bouton « Actualiser le catalogue » (Fournisseur IA) ;
 * il n'existe pas deux implémentations. Elle enchaîne :
 *   1. catalogue modèles : `GET /v1beta/models` avec la clé active —
 *      découverte, statut fournisseur, disparition (`refreshModelCatalog`) ;
 *   1 bis. lot 85C (CAT-03) : FICHES DE CAPACITÉS figées dans le catalogue ;
 *      un changement de fiche est journalisé et marque « requalification
 *      nécessaire » (événement) — un passage sans changement ne lance rien (R46) ;
 *   2. qualification technique automatique des modèles listés jamais
 *      qualifiés ou marqués à requalifier (plus jamais par ancienneté), hors
 *      expérimentaux ET Preview (décision PO 02) — bornée par passage ;
 *   3. statut opérationnel : génération minimale des modèles déjà
 *      utilisables (registre ou qualifiés) ;
 *   4. catalogue tarifaire : page officielle Google (`syncPricingCatalog`) —
 *      indépendant : une panne de la source tarifaire n'empêche rien ;
 *   5. baseline du bandeau à la première synchronisation réussie ;
 *   6. modèles actifs devenus inutilisables : UNE alerte d'exploitation par
 *      modèle et fenêtre (lot 49), sans jamais modifier la configuration.
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
  /** Lot 85C : fiches de capacités (changements, requalifications marquées). */
  capabilities?: { checked: number; changed: string[]; requalificationMarked: string[] };
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
  /** Pause avant le second contrôle d'un modèle suspect (ms) ; injecté en test. */
  confirmDelayMs?: number;
  /** Alerte d'exploitation ; injectée en test. */
  raiseAlert?: (a: import('../alerts/alerts.repository').AlertInput) => Promise<boolean>;
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
 * récents d'abord). Les expérimentaux ne sont jamais qualifiés ; lot 85C
 * (décision PO 02, CAT-02, R01, R69) : les Preview non plus — visibles au
 * catalogue pour information seulement.
 */
export function qualificationOrder(
  listed: readonly Pick<ListedModel, 'model' | 'lifecycle'>[],
  priority: { active: ReadonlySet<string>; declared: ReadonlySet<string>; discovered?: ReadonlySet<string> },
): string[] {
  const rang = (m: string) => (priority.discovered?.has(m) ? 0 : priority.active.has(m) ? 1 : priority.declared.has(m) ? 2 : 3);
  return listed
    .filter((m) => m.lifecycle !== 'experimental' && m.lifecycle !== 'preview')
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

    // 1 bis. Lot 85C : fiches de capacités ; changement → requalification marquée.
    const { recordCapabilitySnapshot } = await import('./model-capabilities.repository');
    if (cat.ok) {
      const c = await recordCapabilitySnapshot({ trigger: opts.trigger, markRequalification: true, now });
      result.capabilities = { checked: c.checked, changed: c.changed, requalificationMarked: c.requalificationMarked };
    }

    if (cat.ok && secret && cat.listed?.length) {
      // 2. Qualification automatique.
      const [Q, { DECLARED_MODELS }, { loadActiveChains }, { recordOperationalCheck, probeModels }, { capabilitiesOf }] = await Promise.all([
        import('./model-qualification.service'), import('../registry/models'), import('./active-model-anomalies'),
        import('./model-operational.service'), import('./model-capabilities'),
      ]);
      const stored = await Q.loadQualifications(secret);
      const actifs = new Set((await loadActiveChains().catch(() => [])).map((c) => c.model));
      const declares = new Set(DECLARED_MODELS.map((m) => m.model));
      const aQualifier = qualificationOrder(cat.listed, { active: actifs, declared: declares, discovered: new Set(cat.discovered ?? []) })
        .filter((m) => Q.needsQualification(stored.get(m), now));
      const manuel = opts.trigger === 'manual';
      const max = deps.maxQualifications ?? (manuel ? 4 : 12);
      const finBudget = Date.now() + (deps.qualificationBudgetMs ?? (manuel ? 20_000 : 8 * 60_000));
      const call = deps.qualificationCall ?? Q.defaultQualificationCall(secret);
      const parModele = new Map(cat.listed.map((m) => [m.model, m]));
      const qualifiesIci = new Set<string>();
      // Lot 49 : échec PRÉSUMÉ de la génération pendant la qualification —
      // modèle suspect, recontrôlé par la sonde ci-dessous (confirmation).
      const aConfirmer = new Set<string>();
      const lot = aQualifier.slice(0, max);
      let traites = 0;
      // Par paquets de 4 modèles en parallèle (épreuves d'un modèle en série) ;
      // arrêt au budget : le reste attend le passage suivant.
      for (let i = 0; i < lot.length && Date.now() < finBudget; i += 4) {
        const paquet = lot.slice(i, i + 4);
        traites += paquet.length;
        const resultats = await Promise.all(paquet.map(async (model) => ({
          model,
          // Lot 85C : épreuves construites d'après la fiche de capacités (constructeur unique).
          r: await Q.qualifyModel(model, call, {
            secret, supportsThinking: parModele.get(model)?.supportsThinking ?? null, capabilities: capabilitiesOf(model),
          }),
        })));
        for (const { model, r } of resultats) {
          const issue = r.generateOutcome ?? (r.generate === true ? { status: 'ok' as const } : null);
          if (r.generate === null) {
            result.qualification.inconclusive.push(model);
            // Non concluant : état retenu inchangé (diagnostic mis à jour).
            // Échec présumé : suspect, puis second contrôle par la sonde.
            if (issue) {
              const etat = await recordOperationalCheck({ model, secret, outcome: issue, source: 'qualification' });
              if (etat.checkStatus === 'suspect') aConfirmer.add(model);
            }
            continue;
          }
          await Q.recordQualification(model, secret, r);
          if (issue) await recordOperationalCheck({ model, secret, outcome: issue, source: 'qualification' });
          qualifiesIci.add(model);
          (r.generate && r.structured !== false ? result.qualification.qualified : result.qualification.failed).push(model);
        }
      }
      result.qualification.remaining = Math.max(0, aQualifier.length - traites);
      // Lot 85C : constats des sondes reportés dans les fiches, SANS marquer de
      // requalification (changement issu de la qualification elle-même).
      if (qualifiesIci.size > 0) await recordCapabilitySnapshot({ trigger: 'qualification', markRequalification: false, now });

      // 3. Statut opérationnel des modèles déjà utilisables.
      const apres = await Q.loadQualifications(secret);
      // Lot 85C (décision 02) : aucun appel à un modèle Preview, sonde comprise.
      const previews = new Set(cat.listed.filter((m) => m.lifecycle === 'preview').map((m) => m.model));
      const aSonder = cat.listed.map((m) => m.model)
        .filter((m) => !previews.has(m) && !qualifiesIci.has(m) && (aConfirmer.has(m) || declares.has(m) || apres.get(m)?.generate))
        .sort((a, b) => Number(aConfirmer.has(b) || actifs.has(b)) - Number(aConfirmer.has(a) || actifs.has(a)))
        .slice(0, MAX_PROBES);
      if (aSonder.length > 0) {
        const probes = await probeModels(aSonder, secret, {
          ...(deps.probeCall ? { call: deps.probeCall } : {}),
          ...(deps.confirmDelayMs !== undefined ? { confirmDelayMs: deps.confirmDelayMs } : {}),
        });
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
      const [{ loadUsableModelsContext }, A, { loadOperationalDiagnostics }] = await Promise.all([
        import('../registry/usable-models'), import('./active-model-anomalies'), import('./model-operational.service'),
      ]);
      const ctx = await loadUsableModelsContext();
      // Lot 87A (INV-10) : chaque anomalie reliée au secours admissible.
      result.anomalies = A.detectActiveModelAnomalies(await A.loadActiveChains(), ctx, await A.loadSecoursContext());
      const diagnostics = result.anomalies.length ? await loadOperationalDiagnostics(secret ?? null) : new Map();
      await A.raiseActiveModelAlerts(result.anomalies, now, deps.raiseAlert, diagnostics);
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
    ...(r.capabilities ? { capabilities: { checked: r.capabilities.checked, changed: r.capabilities.changed, requalify: r.capabilities.requalificationMarked } } : {}),
    probed: r.operational.probed, notOperational: r.operational.failed,
    pricing: { status: r.pricing.status, known: r.pricing.known, unknown: r.pricing.unknown, changed: r.pricing.changed, ...(r.pricing.error ? { error: r.pricing.error } : {}) },
    ...(r.baseline ? { baseline: true } : {}),
    anomalies: r.anomalies.map((a) => `${a.treatment}/${a.rank}/${a.model}`),
    ...(r.anomalies.length ? { unavailableModels: [...new Set(r.anomalies.map((a) => a.model))] } : {}),
  };
}
