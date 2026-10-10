/**
 * Réconciliation de la CONNAISSANCE OUVERTE d'un compte (lot 34E — ticket
 * « T3 : rendre la réconciliation globale réellement continue »,
 * §« Réconciliation compte »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Appelée par la réconciliation compte (`reconcileAccount`, travaux
 * événementiels temporisés / dédupliqués de la file T3 et balayage planifié)
 * — même orchestration T3, aucun système parallèle. Elle détecte ce qui est
 * encore OUVERT et détermine si l'état actuel permet une meilleure résolution :
 *
 *   1. faits sans cible (ou ciblés sur le bien) rapprochables d'un équipement
 *      ou d'un bien par identifiant exact (`fact-target-reconciler.ts`) ;
 *   1 bis. documents rattachés PAR L'UTILISATEUR dont un identifiant désigne
 *      désormais un autre bien : jamais déplacés — carte d'incohérence
 *      LINK-ASSET-CONFLICT (`user-decision-conflicts.ts`) ;
 *   2. documents sans bien principal en NO_CANDIDATE / ABSTAINED / MULTI_ASSET
 *      (y compris ceux présents dans « À traiter ») : contexte reconstruit,
 *      empreinte comparée — inchangée → CONFIRMED_NO_CHANGE sans IA ;
 *      modifiée → travail T3 DOCUMENT_ASSET (déterministe d'abord) ;
 *   3. titres SYSTEM dont le contexte a pu changer (rattachement /
 *      détachement, bien ou équipement renommé, nouvelle analyse) : contrôle
 *      ciblé par le moteur de titre commun (même sélection que le balayage
 *      `document_title_sweep`, bornée au compte) — le titre suit la
 *      connaissance sans attendre le balayage horaire.
 *
 * Ciblage : seuls les objets OUVERTS du compte sont relus, et seulement si la
 * révision de connaissance a avancé depuis leur dernière évaluation ; l'index
 * de rapprochement est construit UNE fois pour tout le passage. Jamais un
 * rescan de la base, jamais T1.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ExecutionGuard } from '../../queue/execution-control';
import { isExecutionCancelled } from '../../queue/execution-control';
import { getAccountKnowledgeRevision } from './knowledge-revision';
import type { FactTargetResult } from './fact-target-reconciler';

/** Documents ouverts examinés au plus par passage compte (le balayage reprend la suite). */
export const OPEN_KNOWLEDGE_DOCUMENT_LIMIT = 200;
/** Titres contrôlés au plus par passage compte (le balayage des titres reprend la suite). */
export const OPEN_KNOWLEDGE_TITLE_LIMIT = 100;

export interface OpenKnowledgeResult {
  knowledgeRevision: number;
  facts: FactTargetResult | null;
  userConflicts: { examined: number; proposed: number } | null;
  documents: { examined: number; confirmed: number; enqueued: number };
  titles: { updated: number; examined: number };
  errors: string[];
}

export async function reconcileOpenKnowledge(
  accountId: number,
  opts: { guard?: ExecutionGuard; triggerCode?: string | null } = {},
): Promise<OpenKnowledgeResult> {
  const [{ MatchingIndexCache }, { reconcileFactTargets }, { sweepAccountDocuments }] = await Promise.all([
    import('../document-asset/matching-index'),
    import('./fact-target-reconciler'),
    import('../document-asset/queue'),
  ]);
  const revision = await getAccountKnowledgeRevision(accountId);
  const indexes = new MatchingIndexCache();
  const out: OpenKnowledgeResult = {
    knowledgeRevision: revision, facts: null, userConflicts: null, documents: { examined: 0, confirmed: 0, enqueued: 0 }, titles: { updated: 0, examined: 0 }, errors: [],
  };

  try {
    out.facts = await reconcileFactTargets({ accountId, revision, index: await indexes.get(accountId), guard: opts.guard });
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    out.errors.push(`FACT_TARGET: ${(e as Error).message}`.slice(0, 300));
  }
  try {
    const { reconcileUserDecisionConflicts } = await import('./user-decision-conflicts');
    const u = await reconcileUserDecisionConflicts({ accountId, revision, index: await indexes.get(accountId), guard: opts.guard });
    out.userConflicts = { examined: u.examined, proposed: u.proposed };
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    out.errors.push(`USER_LINK_CONFLICT: ${(e as Error).message}`.slice(0, 300));
  }
  try {
    const d = await sweepAccountDocuments({
      accountId, guard: opts.guard, triggerCode: opts.triggerCode ?? 'schedule_hourly', limit: OPEN_KNOWLEDGE_DOCUMENT_LIMIT, indexes,
    });
    out.documents = { examined: d.examined, confirmed: d.confirmed, enqueued: d.enqueued.length };
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    out.errors.push(`DOCUMENT_ASSET: ${(e as Error).message}`.slice(0, 300));
  }
  try {
    const { sweepDocumentTitles } = await import('../document-title-sweep');
    const c = await sweepDocumentTitles({ accountId, limit: OPEN_KNOWLEDGE_TITLE_LIMIT, guard: opts.guard });
    out.titles = { updated: c.UPDATED, examined: Object.values(c).reduce((n, x) => n + x, 0) };
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    out.errors.push(`DOCUMENT_TITLE: ${(e as Error).message}`.slice(0, 300));
  }
  if (out.errors.length) console.error(`[t3-open-knowledge] compte ${accountId} :`, out.errors.join(' | '));
  return out;
}
