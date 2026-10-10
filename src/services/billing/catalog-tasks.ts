/**
 * Tâches planifiées internes du catalogue Stripe (lot 25 : aucun
 * planificateur externe, aucune commande à lancer) — CDC lookup_key V4
 * §16.4, LK-102, LK-103, D3 à D9, EX-006, EX-016.
 *
 *   stripe-catalog-sync        /5 min  relit les six clés, publie les
 *                                      projections (≤ 5 min de fraîcheur,
 *                                      filet de sécurité des webhooks), et
 *                                      exécute la reprise historique tant
 *                                      qu'elle n'a pas abouti ;
 *   stripe-catalog-publish     /5 min  publie la grille du CODE quand elle
 *                                      diffère de la dernière publiée, après
 *                                      reprise terminée et 20 min de code
 *                                      homogène (bail partagé, une seule
 *                                      exécution, aucun dégel sur échec) ;
 *   stripe-price-revaluation   /1 h    applique la campagne de revalorisation
 *                                      (lignes prouvées, préavis échu) et
 *                                      constate les bascules.
 * Arrêt d'urgence : SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH=off, etc.
 */
import type { TaskRunContext, TaskRunResult } from '@/services/scheduling/scheduled-tasks.catalog';

export async function runCatalogSyncTask(ctx: TaskRunContext): Promise<TaskRunResult> {
  const { catalogDeps, refreshCatalog } = await import('./price-catalog.service');
  const { manifestRevision } = await import('./pricing-manifest');
  const d = catalogDeps();
  const context = d.context();
  if (!context.mode) return { note: 'STRIPE_SECRET_KEY absente : rien à faire' };
  await d.store.ensureState(context.catalogContext);
  await d.store.setCandidate(context.catalogContext, manifestRevision(), d.now());
  const r = await refreshCatalog({ source: `task:${ctx.trigger}` }, d);
  const state = await d.store.getState(context.catalogContext);
  let backfill = 'terminée';
  if (!state?.backfillCompletedAt) {
    const { runPriceBackfill } = await import('./price-backfill.service');
    const b = await runPriceBackfill({ trigger: `task:${ctx.trigger}`, deadline: Math.min(ctx.deadline, Date.now() + 8 * 60_000) }, d);
    backfill = 'skipped' in b ? b.skipped : b.completed ? 'terminée' : `${b.blocking} référence(s) bloquante(s)`;
  }
  const note = `catalogue : ${r.status}${r.reason ? ` (${r.reason})` : ''} ; reprise historique : ${backfill}`;
  return r.status === 'failed' ? { error: r.reason ?? 'échec', note } : { note };
}

export async function runCatalogPublishTask(): Promise<TaskRunResult> {
  const { catalogDeps } = await import('./price-catalog.service');
  const { manifestRevision } = await import('./pricing-manifest');
  const { publishCodeCatalog, shouldAutoPublish } = await import('./catalog-publication.service');
  const d = catalogDeps();
  const context = d.context();
  if (!context.mode) return { note: 'STRIPE_SECRET_KEY absente : rien à faire' };
  const state = await d.store.getState(context.catalogContext);
  const decision = shouldAutoPublish(state, manifestRevision(), d.now());
  if (!decision.publish) return { note: `aucune publication (${decision.reason})` };
  const r = await publishCodeCatalog({ trigger: 'auto', actor: 'task:stripe-catalog-publish' }, d);
  if (r.status === 'failed') return { error: `publication en échec (${r.step}) : ancienne grille conservée`, note: r.reason };
  return { note: `publication : ${r.status}${'reason' in r ? ` (${r.reason})` : ''}` };
}

export async function runRevaluationTask(ctx: TaskRunContext): Promise<TaskRunResult> {
  const { runRevaluationTick } = await import('./price-revaluation.service');
  const r = await runRevaluationTick({ deadline: Math.min(ctx.deadline, Date.now() + 8 * 60_000) });
  const note = JSON.stringify(r);
  return r.failed > 0 ? { note, error: `${r.failed} revalorisation(s) en échec (ancien tarif maintenu)` } : { note };
}
