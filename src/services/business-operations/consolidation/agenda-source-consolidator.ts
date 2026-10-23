/**
 * Réconciliation T3 d'un élément d'AGENDA modifié par l'utilisateur — sources
 * AGENDA (lot 47B, point 1 ; CDC Opérations V1 ch. 3.1, 17, B4, B9, B16, C2,
 * C4 TRG-012 à TRG-014, C5, C6, C7.2, C8, C16.1, C16.2, C19 ; F-020 à F-022,
 * F-085 à F-087).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNITÉ DE TRAVAIL : UN ÉLÉMENT, UNE TRANSACTION, LE VERROU DU COMPTE
 *
 *   1. relire l'élément (compte, biens vivants, statut, lien
 *      `business_operation_id`) et ses sources AGENDA ;
 *   2. élément RELIÉ à une INTERVENTION active et porté par l'utilisateur
 *      (garde anti-blanchiment) → source AGENDA de CETTE Opération (jamais
 *      une nouvelle : un événement projeté puis modifié corrige l'Opération
 *      qu'il représente, C19) ;
 *   3. élément NON relié, saisi à la main, qui décrit une intervention
 *      décidée (règles fermées, `agendaEstablishesIntervention`) :
 *        · rapprochement AVANT création (P04) : même document, ou même bien +
 *          même acte + date proche (`matchAgendaItem`, C16.1) → rattaché ;
 *          plausible / plusieurs → rien (ni doublon, ni rattachement hasardeux) ;
 *        · sinon machine C5 / C6 / C7 commune (`decideCandidate`) → CREATE_NEW
 *          (INTERVENTION ENVISAGED ou REALIZED, C5 « AGENDA action métier
 *          explicite ») ; l'élément est RELIÉ à l'Opération (la projection
 *          ne crée donc pas de second événement, C16.1) ;
 *   4. sources AGENDA de l'élément qui ne valent plus (élément supprimé,
 *      délié, plus porté par l'utilisateur, annulé à côté d'autres preuves) :
 *      retirées par la reconsolidation de l'Opération (C9, F-086 : invalidée
 *      si plus rien ne la prouve) ;
 *   5. chaque Opération touchée est reconsolidée depuis TOUTES ses sources.
 *
 * ANTI-BOUCLE (C16.2) : le lien `business_operation_id` est écrit
 * directement (jamais par `AgendaWriteService`, donc aucun déclencheur) ; la
 * projection qui suit la mise à jour de l'Opération ne réécrit jamais un
 * élément touché par l'utilisateur et n'émet aucun déclencheur T3.
 * Événements Opération publiés APRÈS commit (bus du lot 39).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { isBusinessOperationIntegrityError } from '../errors';
import type { DbTx } from '../lock';
import { withBusinessOperationWrite, type WriteSession } from '../write';
import {
  AGENDA_SOURCE_LOCATOR, agendaContribution, agendaEstablishesIntervention, agendaIdentity, agendaSourceVersion, applyAgendaAuthority,
  matchAgendaItem,
  type AgendaSourceItem,
} from './agenda-source';
import { loadAgendaMatchOperations, loadAgendaSourceItem, loadAgendaSources } from './agenda-source-read';
import { emptyCardNeeds, type OperationCardNeeds } from './card-needs';
import {
  Changes, STALE_AGENDA_SOURCE_SQL, loadAssetContext, loadMatchableOperations, reconsolidateOperation, syncCards, typeInput,
  type ConsolidationOptions,
} from './consolidator';
import { decideCandidate } from './matching';
import { consolidateOperationState } from './model';
// Lot 82D : appartenance Agenda ↔ Opération par le service unique de regroupement.
import { attachAgendaItem, runnerContext } from '../grouping/service';
import { drizzleRunner } from '../grouping/runner';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const todayUtc = () => new Date().toISOString().slice(0, 10);

export type AgendaSourceOutcome =
  | 'NONE'              // rien à faire (élément non éligible, non relié à une intervention)
  | 'LINKED'            // source AGENDA de l'Opération reliée (suivie, reconsolidée)
  | 'WITHDRAWN'         // sources AGENDA retirées (élément supprimé, délié, annulé…)
  | 'CREATE_NEW' | 'MATCH_AND_ENRICH' | 'HOLD_UNRESOLVED';

export interface AgendaSourceResult {
  itemId: number;
  outcome: AgendaSourceOutcome;
  reason: string | null;
  operationId: number | null;
  changes: number;
  error?: string;
}

/**
 * Relie l'élément à l'Opération (si non relié, ou relié à une Opération
 * inactive). Rend vrai si écrit. Lot 82D : service unique de regroupement
 * (décision T3 ; élément lié — le principal reste la décision de la
 * projection T4 ; un refus de l'utilisateur est respecté).
 */
async function linkItem(tx: DbTx, accountId: number, itemId: number, operationId: number): Promise<boolean> {
  const r = await attachAgendaItem(runnerContext(drizzleRunner(tx), accountId), { operationId, itemId, origin: 'T3', reasonCode: 'T3_AGENDA_SOURCE_LINK' });
  return r.changed;
}

/** Type de l'Opération (null : introuvable ou inactive). */
async function operationType(tx: DbTx, accountId: number, operationId: number): Promise<{ type: string | null } | null> {
  const [o] = await rows<{ type_code: string | null }>(tx, sql`
    SELECT type_code FROM business_operations
     WHERE id = ${operationId} AND account_id = ${accountId} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`);
  return o ? { type: o.type_code ?? null } : null;
}

/**
 * Réconciliation d'UN élément dans une session d'écriture Opération ouverte
 * (verrou du compte détenu). Voir l'en-tête.
 */
export async function reconcileAgendaItemInSession(
  session: WriteSession, accountId: number, itemId: number,
  opts: { today?: string; cards?: OperationCardNeeds } = {},
): Promise<AgendaSourceResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const today = opts.today ?? todayUtc();
  const cards = opts.cards ?? emptyCardNeeds();
  const changes = new Changes();
  const res: AgendaSourceResult = { itemId, outcome: 'NONE', reason: null, operationId: null, changes: 0 };
  const item = await loadAgendaSourceItem(tx, accountId, itemId);
  const sources = await loadAgendaSources(tx, accountId, itemId);
  const touched = new Set<number>(sources.filter((s) => s.active).map((s) => s.operationId));

  const fin = async (): Promise<AgendaSourceResult> => {
    for (const id of [...touched].sort((a, b) => a - b)) await reconsolidateOperation(repo, tx, id, today, changes, cards);
    res.changes = changes.n;
    if (res.outcome === 'NONE' && sources.some((s) => s.active)) {
      const encore = (await loadAgendaSources(tx, accountId, itemId)).some((s) => s.active);
      if (!encore) res.outcome = 'WITHDRAWN';
    }
    return res;
  };

  // Élément supprimé (TRG-014) : la reconsolidation retire ses sources.
  if (!item) { res.reason = 'ITEM_GONE'; return fin(); }

  const source = (version: string) => ({
    kind: 'AGENDA' as const, entityKey: itemId, version, role: null,
    locator: { ...AGENDA_SOURCE_LOCATOR }, authority: 'USER' as const, confidence: 'certain' as const,
  });

  // ── Élément RELIÉ (TRG-013) ────────────────────────────────────────────
  if (item.businessOperationId !== null) {
    const op = await operationType(tx, accountId, item.businessOperationId);
    if (op) {
      const autres = await rows(tx, sql`
        SELECT 1 FROM business_operation_sources
         WHERE operation_id = ${item.businessOperationId} AND active AND source_kind <> 'AGENDA'
           AND NOT (source_kind = 'USER_ARBITRATION' AND locator ? 'decision') LIMIT 1`);
      const d = agendaContribution(item, { operationId: item.businessOperationId, operationType: op.type, otherSupport: autres.length > 0, today });
      if (d.kind === 'CONTRIBUTES') {
        const avant = sources.find((s) => s.active && s.operationId === item.businessOperationId);
        const sourceId = await repo.addSource(item.businessOperationId, { ...source(agendaSourceVersion(item)), matchReason: 'AGENDA_LINKED_ITEM' }, 'AGENDA_SOURCE');
        if (!avant) changes.track(true);
        await repo.refreshSourceVersion(sourceId, agendaSourceVersion(item));
        touched.add(item.businessOperationId);
        res.outcome = 'LINKED';
        res.operationId = item.businessOperationId;
      } else {
        res.reason = d.reason;
      }
      return fin();
    }
  }

  // ── Élément NON relié (TRG-012) ────────────────────────────────────────
  const intent = agendaEstablishesIntervention(item);
  if (intent.kind === 'NONE') { res.reason = intent.reason; return fin(); }

  const m = matchAgendaItem(item, intent.status, await loadAgendaMatchOperations(tx, accountId, item));
  if (m.kind === 'HOLD') {
    res.outcome = 'HOLD_UNRESOLVED';
    res.reason = m.reason;
    console.info(JSON.stringify({ event: 't3.agenda_source_hold', accountId, itemId, reason: m.reason, operationIds: m.operationIds }));
    return fin();
  }
  let operationId: number | null = m.kind === 'MATCH' ? m.operationId : null;
  let reason = m.kind === 'MATCH' ? `AGENDA_MATCH: ${m.reason}` : '';

  if (operationId === null) {
    // Machine commune C5 / C6 / C7 (références, cycle, périmètre du bien, même source retirée puis rétablie).
    const identity = agendaIdentity(item, intent.status, today);
    const anciennes = [...new Set(sources.filter((s) => !s.active).map((s) => s.operationId))];
    const actx = await loadAssetContext(tx, accountId, [...identity.assetIds], []);
    const ops = (await loadMatchableOperations(tx, accountId, identity, anciennes))
      .map((o) => ({ ...o, sameSource: anciennes.includes(o.id) }));
    const d = decideCandidate(identity, { operations: ops, confirmed: new Set(), rejected: new Set(), assetStatus: actx.status });
    if (d.outcome === 'MATCH_AND_ENRICH' && d.operationId !== null && !d.mergeIds?.length) {
      operationId = d.operationId;
      reason = d.reason;
    } else if (d.outcome === 'CREATE_NEW') {
      const s = applyAgendaAuthority(consolidateOperationState('INTERVENTION', [{ sourceId: 0, identity }], today), [{ sourceId: 0, identity }]);
      const created = await repo.create({
        type: typeInput('INTERVENTION'), status: s.status,
        plannedDate: s.plannedDate, realizedDate: s.realizedDate,
        technicalLabel: identity.summary || null,
        source: { ...source(agendaSourceVersion(item)), matchMethod: null, matchReason: `AGENDA_${d.reason}` },
        assets: s.assets.map((a) => ({ assetId: a.assetId, role: s.assets.length === 1 ? 'PRIMARY' : 'CONCERNED', authority: 'USER' as const })),
        equipments: s.equipments.map((e) => ({ equipmentId: e.equipmentId, authority: 'USER' as const })),
        reasonCode: 'AGENDA_CREATE',
      });
      changes.track(true);
      await linkItem(tx, accountId, itemId, created.id);
      touched.add(created.id);
      res.outcome = 'CREATE_NEW';
      res.reason = d.reason;
      res.operationId = created.id;
      return fin();
    } else {
      res.outcome = 'HOLD_UNRESOLVED';
      res.reason = d.reason;
      return fin();
    }
  }

  // Rattachement : source AGENDA de l'Opération existante, élément relié.
  const avant = await rows<{ id: string }>(tx, sql`SELECT id FROM business_operation_sources WHERE operation_id = ${operationId} AND active`);
  const sourceId = await repo.addSource(operationId, { ...source(agendaSourceVersion(item)), matchMethod: 'M2', matchReason: reason.slice(0, 200) }, 'AGENDA_MATCH');
  if (!avant.some((x) => Number(x.id) === sourceId)) changes.track(true);
  await repo.refreshSourceVersion(sourceId, agendaSourceVersion(item));
  if (await linkItem(tx, accountId, itemId, operationId)) changes.track(true);
  touched.add(operationId);
  res.outcome = 'MATCH_AND_ENRICH';
  res.reason = reason;
  res.operationId = operationId;
  return fin();
}

/**
 * Réconciliation des éléments désignés par les déclencheurs `agenda_changed`
 * (une transaction par élément). Événements Opération et cartes après commit.
 * Erreur d'intégrité (NFR-OP-008) : journalisée, l'élément est passé.
 */
export async function consolidateAgendaItems(
  accountId: number, itemIds: readonly number[], opts: ConsolidationOptions = {},
): Promise<AgendaSourceResult[]> {
  const out: AgendaSourceResult[] = [];
  for (const itemId of [...new Set(itemIds)].filter((x) => Number.isSafeInteger(x) && x > 0).sort((a, b) => a - b)) {
    await opts.beforeWrite?.('réconciliation d\'un élément d\'agenda');
    let cards = emptyCardNeeds();
    try {
      const r = await withBusinessOperationWrite(accountId, async (_repo, session) => {
        cards = emptyCardNeeds();
        return reconcileAgendaItemInSession(session, accountId, itemId, { today: opts.today, cards });
      }, { correlationId: opts.correlationId });
      if (opts.syncCards !== false && (cards.reviewedOperations.length || cards.reviewedFiles.length)) await syncCards(accountId, cards);
      out.push(r);
    } catch (e) {
      if (!isBusinessOperationIntegrityError(e)) throw e;
      console.error(`[t3-operations] élément d'agenda ${itemId} (compte ${accountId}) : ${e.message}`);
      out.push({ itemId, outcome: 'NONE', reason: null, operationId: null, changes: 0, error: e.code });
    }
  }
  return out;
}

/**
 * Éléments dont une source AGENDA active ne vaut plus à coup sûr (élément
 * supprimé ou parti dans un autre compte) — filet du balayage horaire.
 */
export async function listStaleAgendaSourceItems(accountId: number, limit = 100): Promise<number[]> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `SELECT DISTINCT s.source_entity_key AS k FROM business_operation_sources s
      WHERE s.account_id = $1 AND ${STALE_AGENDA_SOURCE_SQL} AND s.source_entity_key ~ '^[0-9]{1,9}$'
      ORDER BY 1 LIMIT $2`,
    [accountId, limit] as never[],
  )) as unknown as Array<{ k: string }>;
  return r.map((x) => Number(x.k));
}

export type { AgendaSourceItem };
