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

export interface IdentityPhaseResult {
  skipped: boolean;
  reason: string | null;
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
    groupKey: g.groupKey, fingerprint: g.fingerprint, family: g.family, label: g.label,
    members: g.members.map((m) => ({ fileId: m.fileId, via: m.via })), excluded: g.excluded, candidateAssetIds: g.candidateAssetIds,
    evidenceKinds: [...kinds].map(([fileId, k]) => ({ fileId, kinds: [...k].sort() })),
  };
}

export async function reconcileIdentityGroups(p: {
  accountId: number; indexes: MatchingIndexCache; guard?: ExecutionGuard;
}): Promise<IdentityPhaseResult> {
  const t0 = Date.now();
  const vide = (reason: string): IdentityPhaseResult => ({
    skipped: true, reason, orphansExamined: 0, anchorsExamined: 0, groups: 0, byStatus: {}, changed: 0,
    cards: { opened: 0, updated: 0, closed: 0, individualClosed: 0 }, recoverableMembers: 0, durationMs: Date.now() - t0,
  });
  const [{ identityGraphFor }, { identityGroupsEnabled }] = await Promise.all([import('./load'), import('./contract')]);
  if (!identityGroupsEnabled()) return vide('DISABLED');
  const index = await p.indexes.get(p.accountId);
  const graph: AccountIdentityGraph | null = await identityGraphFor(p.accountId, index);
  if (!graph) return vide('GRAPH_UNAVAILABLE');
  await p.guard?.assertActive('T3 identités documentaires — cartes groupées');
  const { syncIdentityGroupCards } = await import('@/services/to-process/identity-group-cards');
  const cards = await syncIdentityGroupCards(p.accountId, graph.groups.filter((g) => g.cardEligible).map(groupCardInputOf));
  await p.guard?.assertActive('T3 identités documentaires — journal des groupes');
  const { persistGroups } = await import('./store');
  const changed = await persistGroups(p.accountId, graph.groups, { cards: cards.cards });
  const byStatus: Partial<Record<GroupStatus, number>> = {};
  for (const g of graph.groups) byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
  const recoverable = graph.groups.filter((g) => g.status === 'DEMONSTRABLE' || g.status === 'ATTESTED' || g.status === 'CONFIRMED')
    .reduce((n, g) => n + g.members.length, 0);
  const out: IdentityPhaseResult = {
    skipped: false, reason: null, orphansExamined: graph.examined.orphans, anchorsExamined: graph.examined.anchors,
    groups: graph.groups.length, byStatus, changed,
    cards: { opened: cards.opened, updated: cards.updated, closed: cards.closed, individualClosed: cards.individualClosed },
    recoverableMembers: recoverable, durationMs: Date.now() - t0,
  };
  if (out.groups > 0 || out.cards.closed > 0) {
    console.info(`[t3-identity] compte ${p.accountId} : ${out.groups} groupe(s) (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')})`
      + ` · cartes groupées +${out.cards.opened} ~${out.cards.updated} -${out.cards.closed} · cartes individuelles couvertes ${out.cards.individualClosed}`
      + ` · membres rattachables ${out.recoverableMembers} · ${out.durationMs} ms`);
  }
  return out;
}
