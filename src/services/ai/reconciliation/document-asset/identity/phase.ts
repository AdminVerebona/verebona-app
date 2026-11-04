/**
 * Phase « IDENTITÉS DOCUMENTAIRES » du passage T3 du compte (lot 105D, ticket
 * « Rattachement rétroactif après création d'un bien », §D2, §F, §G).
 *
 * Appelée par la réconciliation de la connaissance ouverte
 * (`reconcileOpenKnowledge`), AVANT le balayage des documents sans bien et la
 * phase « À traiter ouverts » — même orchestration T3, aucun moteur parallèle :
 *   1. graphe d'identité du compte (connaissance persistée, `load.ts`) ;
 *   2. journal des groupes (`document_identity_groups`) : membres, ancres,
 *      exclus, provenance, contradictions, statut face aux biens ;
 *   3. cartes groupées (LINK-ASSET-GROUP) synchronisées, cartes individuelles
 *      des membres couverts fermées.
 * Les rattachements eux-mêmes restent faits par T3 DOCUMENT_ASSET, document
 * par document : l'empreinte de contexte de chaque membre porte l'état de son
 * groupe — un groupe devenu DEMONSTRABLE / ATTESTED / CONFIRMED rend ses
 * membres réévaluables (balayage du même passage, « À traiter » ouverts).
 * Aucun appel modèle ici.
 */
import type { ExecutionGuard } from '../../../queue/execution-control';
import type { MatchingIndexCache } from '../matching-index';
import type { AccountIdentityGraph, GroupStatus, IdentityGroup } from './graph';

/**
 * Lot 108E (A5) — état de la phase, jamais « fait » par défaut :
 *   DONE              graphe lu, groupes journalisés, cartes synchronisées ;
 *   NO_RELEVANT_GROUP graphe lu, aucun groupe (compte sans identité croisée) ;
 *   DISABLED          coupure volontaire `T3_IDENTITY_GROUPS_ENABLED=0` ;
 *   PARTIAL           graphe illisible (panne transitoire) ou journal partiel
 *                     (migration 1060 absente) : documents non traités chiffrés ;
 *   FAILED            migration 0995 absente : phase non exécutée.
 */
export type IdentityPhaseState = 'DONE' | 'NO_RELEVANT_GROUP' | 'DISABLED' | 'PARTIAL' | 'FAILED';

export interface IdentityPhaseResult {
  skipped: boolean;
  reason: string | null;
  /** Lot 108E : état explicite de la phase. */
  state?: IdentityPhaseState;
  /** Lot 108E : cause technique (panne), reprise prévue, documents sans bien NON traités par la phase. */
  error?: string | null;
  untreatedDocuments?: number;
  resume?: string | null;
  /** Lot 108E : migrations requises présentes. */
  migrations?: { m0995: boolean; m1060: boolean } | null;
  /** Lot 108E : groupes par famille ; groupes non journalisés (motif). */
  byFamily?: Partial<Record<string, number>>;
  notJournaled?: Array<{ groupKey: string; reason: string }>;
  /** Lot 108E : couverture des sources T1 des documents sans bien (compteurs exhaustifs). */
  sources?: { documents: number; bySource: Record<string, number>; absentBySource: Record<string, number> };
  orphansExamined: number;
  anchorsExamined: number;
  groups: number;
  byStatus: Partial<Record<GroupStatus, number>>;
  /** Groupes nouveaux ou modifiés (journal). */
  changed: number;
  cards: { opened: number; updated: number; closed: number; individualClosed: number };
  /** Documents membres d'un groupe rattachable (repris par T3 DOCUMENT_ASSET). */
  recoverableMembers: number;
  durationMs: number;
}

/** Entrée de carte d'un groupe (pure). */
export function groupCardInputOf(g: IdentityGroup) {
  const kinds = new Map<number, Set<string>>();
  for (const s of g.evidence) (kinds.get(s.fileId) ?? kinds.set(s.fileId, new Set()).get(s.fileId)!).add(s.kind);
  return {
    // Carte groupée : familles « bien » seulement (`cardEligible` exclut les appareils).
    groupKey: g.groupKey, fingerprint: g.fingerprint, family: g.family as 'PROPERTY' | 'VEHICLE', label: g.label,
    members: g.members.map((m) => ({ fileId: m.fileId, via: m.via })), excluded: g.excluded, candidateAssetIds: g.candidateAssetIds,
    evidenceKinds: [...kinds].map(([fileId, k]) => ({ fileId, kinds: [...k].sort() })),
  };
}

export async function reconcileIdentityGroups(p: {
  accountId: number; indexes: MatchingIndexCache; guard?: ExecutionGuard;
}): Promise<IdentityPhaseResult> {
  const t0 = Date.now();
  const vide = (reason: string, state: IdentityPhaseState, extra: Partial<IdentityPhaseResult> = {}): IdentityPhaseResult => ({
    skipped: true, reason, state, orphansExamined: 0, anchorsExamined: 0, groups: 0, byStatus: {}, changed: 0,
    cards: { opened: 0, updated: 0, closed: 0, individualClosed: 0 }, recoverableMembers: 0, durationMs: Date.now() - t0, ...extra,
  });
  const [{ identityGraphOutcomeFor }, { identityGroupsEnabled }, sup] = await Promise.all([import('./load'), import('./contract'), import('./supervision')]);
  if (!identityGroupsEnabled()) return vide('DISABLED', 'DISABLED');
  const index = await p.indexes.get(p.accountId);
  const issue = await identityGraphOutcomeFor(p.accountId, index);
  if (!issue.graph) {
    // Lot 108E (A5) : panne ≠ coupure — documents non traités chiffrés, Supervision, reprise au passage suivant.
    const untreated = await sup.countOrphanDocuments(p.accountId).catch(() => -1);
    const state: IdentityPhaseState = issue.status === 'MIGRATION_MISSING' ? 'FAILED' : 'PARTIAL';
    const reason = issue.status === 'MIGRATION_MISSING' ? 'MIGRATION_MISSING' : 'GRAPH_UNAVAILABLE';
    await sup.reportIdentityPhaseFailure({ accountId: p.accountId, reason, error: issue.error, untreatedDocuments: untreated, migrations: issue.migrations });
    return vide(reason, state, {
      error: issue.error, untreatedDocuments: untreated, migrations: issue.migrations,
      resume: 'reprise automatique au prochain passage T3 du compte (balayage horaire) ; documents réévalués dès que le graphe est lisible',
    });
  }
  const graph: AccountIdentityGraph = issue.graph;
  await p.guard?.assertActive('T3 identités documentaires — cartes groupées');
  const { syncIdentityGroupCards } = await import('@/services/to-process/identity-group-cards');
  const cards = await syncIdentityGroupCards(p.accountId, graph.groups.filter((g) => g.cardEligible).map(groupCardInputOf));
  await p.guard?.assertActive('T3 identités documentaires — journal des groupes');
  const { persistGroups } = await import('./store');
  const notJournaled: Array<{ groupKey: string; reason: string }> = [];
  const changed = await persistGroups(p.accountId, graph.groups, { cards: cards.cards, equipmentFamilyAllowed: issue.migrations?.m1060 !== false, skipped: notJournaled });
  const byStatus: Partial<Record<GroupStatus, number>> = {};
  const byFamily: Partial<Record<string, number>> = {};
  for (const g of graph.groups) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    byFamily[g.family] = (byFamily[g.family] ?? 0) + 1;
  }
  const recoverable = graph.groups.filter((g) => g.status === 'DEMONSTRABLE' || g.status === 'ATTESTED' || g.status === 'CONFIRMED')
    .reduce((n, g) => n + g.members.length, 0);
  const bySource: Record<string, number> = {};
  const absentBySource: Record<string, number> = {};
  for (const c of (graph.coverage ?? new Map()).values() as Iterable<{ counts: Record<string, number>; absent: string[] }>) {
    for (const [k, v] of Object.entries(c.counts)) if (v > 0) bySource[k] = (bySource[k] ?? 0) + 1;
    for (const k of c.absent) absentBySource[k] = (absentBySource[k] ?? 0) + 1;
  }
  const partiel = notJournaled.length > 0;
  const out: IdentityPhaseResult = {
    skipped: false, reason: partiel ? 'MIGRATION_1060_MISSING' : null,
    state: partiel ? 'PARTIAL' : graph.groups.length === 0 ? 'NO_RELEVANT_GROUP' : 'DONE',
    error: partiel ? `${notJournaled.length} groupe(s) d'appareil non journalisé(s) : migration 1060 absente` : null,
    untreatedDocuments: 0, migrations: issue.migrations, byFamily, notJournaled,
    sources: { documents: graph.coverage?.size ?? 0, bySource, absentBySource },
    orphansExamined: graph.examined.orphans, anchorsExamined: graph.examined.anchors,
    groups: graph.groups.length, byStatus, changed,
    cards: { opened: cards.opened, updated: cards.updated, closed: cards.closed, individualClosed: cards.individualClosed },
    recoverableMembers: recoverable, durationMs: Date.now() - t0,
  };
  // Contrôle APRÈS correction : la phase lit de nouveau le graphe → l'incident Supervision du compte est résolu.
  await sup.resolveIdentityPhaseFailure(p.accountId, partiel ? ['MIGRATION_1060_MISSING'] : []);
  if (partiel) await sup.reportIdentityPhaseFailure({ accountId: p.accountId, reason: 'MIGRATION_1060_MISSING', error: out.error ?? null, untreatedDocuments: 0, migrations: issue.migrations });
  if (out.groups > 0 || out.cards.closed > 0) {
    console.info(`[t3-identity] compte ${p.accountId} : ${out.groups} groupe(s) (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')})`
      + ` · familles ${Object.entries(byFamily).map(([k, v]) => `${k} ${v}`).join(', ')}`
      + ` · cartes groupées +${out.cards.opened} ~${out.cards.updated} -${out.cards.closed} · cartes individuelles couvertes ${out.cards.individualClosed}`
      + ` · membres rattachables ${out.recoverableMembers} · ${out.durationMs} ms`);
  }
  return out;
}
