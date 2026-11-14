/**
 * GRAPHE CANONIQUE des événements de référence — accès aux données (lot 114O,
 * carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §19, §20, §22 ; lot B).
 *
 * SEUL fichier qui écrit `business_operation_relations`,
 * `business_operation_agenda_links` (liens supplémentaires ; les liens de la
 * colonne historique sont tenus par le déclencheur 1716),
 * `business_operation_graph_history` et `business_operation_declarations`
 * (déclarations de l'utilisateur, migration 1718). Appelé par :
 *   · la façade métier `operation-write.facade.ts` (commandes) ;
 *   · la fusion existante du dépôt (`reassignGraphOnMerge`) ;
 *   · le transfert d'un bien entre comptes (`detachCrossAccountGraphInTx`).
 *
 * Chaque fonction reçoit un `GroupingRunner` (même exécuteur que le service
 * unique de regroupement : transaction Drizzle ou postgres.js) et suppose le
 * verrou des Opérations du compte DÉTENU par l'appelant (espace 39101).
 * ISOLATION : toute requête est bornée au compte (`account_id = $n`) ; un
 * objet d'un autre compte est rendu « introuvable », jamais lu ni écrit.
 * Aucune IA, aucun événement d'Agenda, aucune composante financière, aucune
 * notification : ces fonctions n'écrivent QUE les trois tables du graphe.
 */
import type { BusinessOperationTypeCode } from '../model';
import type { GroupingRunner } from '../grouping/runner';
import {
  mergedRelationState, orientRelation,
  type GraphEvidence, type GraphHistoryAction, type GraphOrigin, type GraphRelationKind, type OperationFacts,
  type OperationRelationNature, type OperationRelationState, type RelationEnds, type RelationSnapshot,
} from './model';

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

// ── Opérations et éléments (lecture sous verrou, bornée au compte) ─────────

/** Opération DU COMPTE, verrouillée ; null si absente ou d'un autre compte (aucune distinction rendue). */
export async function loadOperationFacts(r: GroupingRunner, accountId: number, operationId: number): Promise<(OperationFacts & { version: number }) | null> {
  const [o] = await r.q<Row>(
    `SELECT id, type_code, version, (invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS active
       FROM business_operations WHERE id = $1 AND account_id = $2 FOR UPDATE`, [operationId, accountId]);
  if (!o) return null;
  return { id: n(o.id), typeCode: (o.type_code as BusinessOperationTypeCode | null) ?? null, active: o.active === true, version: n(o.version) };
}

export interface AgendaItemFacts { id: number; legacyOperationId: number | null; legacyOperationActive: boolean }

/** Élément d'Agenda DU COMPTE, verrouillé ; null si absent ou d'un autre compte. */
export async function loadAgendaItemFacts(r: GroupingRunner, accountId: number, itemId: number): Promise<AgendaItemFacts | null> {
  const [i] = await r.q<Row>(
    `SELECT i.id, i.business_operation_id AS op,
            (o.id IS NOT NULL AND o.account_id = i.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS op_active
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
      WHERE i.id = $1 AND i.account_id = $2 FOR UPDATE OF i`, [itemId, accountId]);
  if (!i) return null;
  return { id: n(i.id), legacyOperationId: nOrNull(i.op), legacyOperationActive: i.op_active === true };
}

// ── Relations entre Opérations ─────────────────────────────────────────────

const RELATION_COLUMNS = `id, from_operation_id, to_operation_id, nature, state, origin, version, evidence_fingerprint`;

function toRelation(x: Row): RelationSnapshot {
  return {
    id: n(x.id), fromOperationId: n(x.from_operation_id), toOperationId: n(x.to_operation_id),
    nature: x.nature as OperationRelationNature, state: x.state as OperationRelationState, origin: x.origin as GraphOrigin,
    version: n(x.version), evidenceFingerprint: (x.evidence_fingerprint as string | null) ?? null,
  };
}

/** Relation de la PAIRE non ordonnée (au plus une), verrouillée. */
export async function findRelation(r: GroupingRunner, accountId: number, a: number, b: number): Promise<RelationSnapshot | null> {
  const [x] = await r.q<Row>(
    `SELECT ${RELATION_COLUMNS} FROM business_operation_relations
      WHERE account_id = $1 AND LEAST(from_operation_id, to_operation_id) = LEAST($2::bigint, $3::bigint)
        AND GREATEST(from_operation_id, to_operation_id) = GREATEST($2::bigint, $3::bigint) FOR UPDATE`, [accountId, a, b]);
  return x ? toRelation(x) : null;
}

export interface RelationWrite {
  ends: RelationEnds;
  nature: OperationRelationNature;
  state: OperationRelationState;
  origin: GraphOrigin;
  reasonCode: string;
  evidence: readonly GraphEvidence[];
  evidenceFingerprint: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  userId: number | null;
}

export async function insertRelation(r: GroupingRunner, accountId: number, w: RelationWrite): Promise<RelationSnapshot> {
  const [x] = await r.q<Row>(
    `INSERT INTO business_operation_relations
       (account_id, from_operation_id, to_operation_id, nature, state, origin, reason_code, evidence, evidence_fingerprint,
        valid_from, valid_to, decided_by_user_id, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10::date, $11::date, $12, CASE WHEN $5 = 'ACTIVE' THEN NULL ELSE now() END)
     RETURNING ${RELATION_COLUMNS}`,
    [accountId, w.ends.fromOperationId, w.ends.toOperationId, w.nature, w.state, w.origin, w.reasonCode, JSON.stringify(w.evidence),
      w.evidenceFingerprint, w.validFrom ?? null, w.validTo ?? null, w.userId]);
  return toRelation(x);
}

/** Réécrit la relation (état, nature, sens, preuves) ; la version avance toujours. */
export async function updateRelation(r: GroupingRunner, accountId: number, relationId: number, w: RelationWrite): Promise<RelationSnapshot> {
  const [x] = await r.q<Row>(
    `UPDATE business_operation_relations
        SET from_operation_id = $3, to_operation_id = $4, nature = $5, state = $6, origin = $7, reason_code = $8,
            evidence = $9::text::jsonb, evidence_fingerprint = $10,
            valid_from = COALESCE($11::date, valid_from), valid_to = COALESCE($12::date, valid_to),
            decided_by_user_id = $13, decided_at = now(), ended_at = CASE WHEN $6 = 'ACTIVE' THEN NULL ELSE now() END,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING ${RELATION_COLUMNS}`,
    [relationId, accountId, w.ends.fromOperationId, w.ends.toOperationId, w.nature, w.state, w.origin, w.reasonCode,
      JSON.stringify(w.evidence), w.evidenceFingerprint, w.validFrom ?? null, w.validTo ?? null, w.userId]);
  return toRelation(x);
}

/** Change le seul ÉTAT d'une relation (retrait, refus) ; nature, sens et preuves d'origine conservés. */
export async function setRelationState(
  r: GroupingRunner, accountId: number, relationId: number,
  p: { state: OperationRelationState; origin: GraphOrigin; reasonCode: string; userId: number | null; evidenceFingerprint?: string | null },
): Promise<RelationSnapshot> {
  const [x] = await r.q<Row>(
    `UPDATE business_operation_relations
        SET state = $3, origin = $4, reason_code = $5, decided_by_user_id = $6, decided_at = now(),
            evidence_fingerprint = COALESCE($7, evidence_fingerprint),
            ended_at = CASE WHEN $3 = 'ACTIVE' THEN NULL ELSE now() END, version = version + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING ${RELATION_COLUMNS}`,
    [relationId, accountId, p.state, p.origin, p.reasonCode, p.userId, p.evidenceFingerprint ?? null]);
  return toRelation(x);
}

// ── Liens Opération ↔ élément d'Agenda ─────────────────────────────────────

export interface AgendaLinkSnapshot { id: number; operationId: number; agendaItemId: number; state: 'ACTIVE' | 'REMOVED'; origin: GraphOrigin; legacyColumn: boolean; version: number }

const LINK_COLUMNS = `id, operation_id, agenda_item_id, state, origin, legacy_column, version`;
const toLink = (x: Row): AgendaLinkSnapshot => ({
  id: n(x.id), operationId: n(x.operation_id), agendaItemId: n(x.agenda_item_id), state: x.state as 'ACTIVE' | 'REMOVED',
  origin: x.origin as GraphOrigin, legacyColumn: x.legacy_column === true, version: n(x.version),
});

export async function findAgendaLink(r: GroupingRunner, accountId: number, operationId: number, itemId: number): Promise<AgendaLinkSnapshot | null> {
  const [x] = await r.q<Row>(
    `SELECT ${LINK_COLUMNS} FROM business_operation_agenda_links WHERE account_id = $1 AND operation_id = $2 AND agenda_item_id = $3 FOR UPDATE`,
    [accountId, operationId, itemId]);
  return x ? toLink(x) : null;
}

/** Pose ou réactive un lien SUPPLÉMENTAIRE (hors colonne historique). Rend le lien et s'il a changé. */
export async function activateExtraAgendaLink(
  r: GroupingRunner, accountId: number,
  p: { operationId: number; itemId: number; origin: GraphOrigin; reasonCode: string; evidence: readonly GraphEvidence[]; userId: number | null },
): Promise<{ link: AgendaLinkSnapshot; action: 'CREATED' | 'REACTIVATED' | 'NO_CHANGE' }> {
  const cur = await findAgendaLink(r, accountId, p.operationId, p.itemId);
  if (cur?.state === 'ACTIVE') return { link: cur, action: 'NO_CHANGE' };
  if (cur) {
    const [x] = await r.q<Row>(
      `UPDATE business_operation_agenda_links
          SET state = 'ACTIVE', ended_at = NULL, origin = $3, reason_code = $4, evidence = $5::text::jsonb, decided_by_user_id = $6,
              decided_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND account_id = $2 RETURNING ${LINK_COLUMNS}`,
      [cur.id, accountId, p.origin, p.reasonCode, JSON.stringify(p.evidence), p.userId]);
    return { link: toLink(x), action: 'REACTIVATED' };
  }
  const [x] = await r.q<Row>(
    `INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code, evidence, decided_by_user_id)
     VALUES ($1, $2, $3, 'ACTIVE', $4, false, $5, $6::text::jsonb, $7) RETURNING ${LINK_COLUMNS}`,
    [accountId, p.operationId, p.itemId, p.origin, p.reasonCode, JSON.stringify(p.evidence), p.userId]);
  return { link: toLink(x), action: 'CREATED' };
}

/** Retire un lien SUPPLÉMENTAIRE actif (jamais un lien de la colonne historique : celui-là suit la colonne). */
export async function removeExtraAgendaLink(
  r: GroupingRunner, accountId: number, linkId: number, p: { origin: GraphOrigin; reasonCode: string; userId: number | null },
): Promise<AgendaLinkSnapshot | null> {
  const [x] = await r.q<Row>(
    `UPDATE business_operation_agenda_links
        SET state = 'REMOVED', ended_at = now(), origin = $3, reason_code = $4, decided_by_user_id = $5, decided_at = now(),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND account_id = $2 AND state = 'ACTIVE' AND NOT legacy_column RETURNING ${LINK_COLUMNS}`,
    [linkId, accountId, p.origin, p.reasonCode, p.userId]);
  return x ? toLink(x) : null;
}

/** Marque d'un geste de l'utilisateur sur un lien tenu par la colonne historique (origine et auteur ; l'état suit la colonne). */
export async function stampAgendaLinkDecision(
  r: GroupingRunner, accountId: number, operationId: number, itemId: number, p: { reasonCode: string; userId: number | null },
): Promise<void> {
  await r.q(
    `UPDATE business_operation_agenda_links SET origin = 'USER', reason_code = $4, decided_by_user_id = $5, decided_at = now(), updated_at = now()
      WHERE account_id = $1 AND operation_id = $2 AND agenda_item_id = $3`, [accountId, operationId, itemId, p.reasonCode, p.userId]);
}

// ── Déclarations de l'utilisateur (source durable, migration 1718) ─────────

/** Enregistre une déclaration (texte utile déjà normalisé). `operationId` null : posée par `attachDeclaration` après la création. */
export async function insertDeclaration(
  r: GroupingRunner, accountId: number,
  p: { purpose: 'CREATE' | 'UPDATE'; channel: string; userId: number | null; text: string; fingerprint: string; operationId: number | null },
): Promise<number> {
  const [d] = await r.q<Row>(
    `INSERT INTO business_operation_declarations (account_id, operation_id, purpose, channel, author_user_id, declaration_text, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [accountId, p.operationId, p.purpose, p.channel, p.userId, p.text, p.fingerprint]);
  return n(d.id);
}

/** Relie la déclaration à l'Opération qu'elle vient de fonder (même compte). */
export async function attachDeclaration(r: GroupingRunner, accountId: number, declarationId: number, operationId: number): Promise<void> {
  await r.q(`UPDATE business_operation_declarations SET operation_id = $3 WHERE id = $2 AND account_id = $1`, [accountId, declarationId, operationId]);
}

export interface ActiveDeclaration { declarationId: number; operationId: number; typeCode: BusinessOperationTypeCode | null; status: string; version: number }

/** Déclaration FONDATRICE identique (même empreinte) d'une Opération toujours active du compte ; null sinon. */
export async function findActiveDeclaration(r: GroupingRunner, accountId: number, fingerprint: string): Promise<ActiveDeclaration | null> {
  const [x] = await r.q<Row>(
    `SELECT d.id, d.operation_id, o.type_code, o.status, o.version
       FROM business_operation_declarations d
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id
      WHERE d.account_id = $1 AND d.purpose = 'CREATE' AND d.fingerprint = $2
        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
      ORDER BY d.id LIMIT 1`, [accountId, fingerprint]);
  if (!x) return null;
  return { declarationId: n(x.id), operationId: n(x.operation_id), typeCode: (x.type_code as BusinessOperationTypeCode | null) ?? null, status: String(x.status), version: n(x.version) };
}

// ── Journal et rejeu ───────────────────────────────────────────────────────

export interface GraphJournalEntry {
  relationKind: GraphRelationKind;
  operationId: number;
  otherOperationId?: number | null;
  agendaItemId?: number | null;
  fileId?: number | null;
  supplierId?: number | null;
  action: GraphHistoryAction;
  origin: GraphOrigin;
  channel?: string | null;
  actorUserId?: number | null;
  reasonCode: string;
  evidence?: readonly GraphEvidence[];
  before?: unknown;
  after?: unknown;
  command?: string | null;
  idempotencyKey?: string | null;
  /** Empreinte de l'entrée de la commande (`commandInputHash`) — avec la clé d'idempotence. */
  inputHash?: string | null;
  result?: unknown;
  correlationId?: string | null;
}

export async function journalGraph(r: GroupingRunner, accountId: number, e: GraphJournalEntry): Promise<void> {
  await r.q(
    `INSERT INTO business_operation_graph_history
       (account_id, relation_kind, operation_id, other_operation_id, agenda_item_id, file_id, action, origin, channel, actor_user_id,
        reason_code, evidence, before_json, after_json, command, idempotency_key, result_json, correlation_id, supplier_id, input_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb, $13::text::jsonb, $14::text::jsonb, $15, $16, $17::text::jsonb, $18, $19, $20)`,
    [accountId, e.relationKind, e.operationId, e.otherOperationId ?? null, e.agendaItemId ?? null, e.fileId ?? null, e.action, e.origin,
      e.channel ?? null, e.actorUserId ?? null, e.reasonCode, JSON.stringify(e.evidence ?? []), json(e.before), json(e.after),
      e.command ?? null, e.idempotencyKey ?? null, json(e.result), e.correlationId ?? null, e.supplierId ?? null, e.inputHash ?? null]);
}

/**
 * Résultat déjà rendu pour cette clé d'idempotence du compte ; null sinon.
 * `sameCommand` : même commande ET même entrée (empreinte) — sinon la clé a
 * été réutilisée pour autre chose : conflit, jamais un rejeu.
 */
export async function findReplay(r: GroupingRunner, accountId: number, command: string, idempotencyKey: string, inputHash: string): Promise<{ result: unknown; sameCommand: boolean } | null> {
  const [x] = await r.q<Row>(
    `SELECT command, input_hash, result_json FROM business_operation_graph_history
      WHERE account_id = $1 AND idempotency_key = $2 AND result_json IS NOT NULL ORDER BY id LIMIT 1`, [accountId, idempotencyKey]);
  if (!x) return null;
  return { result: x.result_json, sameCommand: x.command === command && x.input_hash === inputHash };
}

// ── Fusion (appelée par `BusinessOperationRepository.mergeOperations`) ─────

/**
 * Part GRAPHE de la fusion existante : les relations et les liens
 * supplémentaires de l'absorbée rejoignent la canonique, sans doublon, sans
 * relation réflexive, sans contourner un refus (CDC §5, §7 : identité
 * canonique après fusion, redirection des anciens liens). Même transaction
 * que la fusion : tout ou rien. Les liens de la colonne historique sont déjà
 * reportés par `reassignGroupingOnMerge` (déclencheur 1716).
 */
export async function reassignGraphOnMerge(
  r: GroupingRunner, accountId: number, absorbedId: number, canonicalId: number, ctx: { correlationId?: string | null; actorUserId?: number | null } = {},
): Promise<{ relationsMoved: number; relationsMerged: number; relationsDropped: number; agendaLinksMoved: number }> {
  const out = { relationsMoved: 0, relationsMerged: 0, relationsDropped: 0, agendaLinksMoved: 0 };
  const base = { origin: 'SYSTEM' as const, reasonCode: 'OPERATION_MERGED', correlationId: ctx.correlationId ?? null, actorUserId: ctx.actorUserId ?? null };
  const lignes = await r.q<Row>(
    `SELECT ${RELATION_COLUMNS}, evidence, decided_by_user_id FROM business_operation_relations
      WHERE account_id = $1 AND (from_operation_id = $2 OR to_operation_id = $2) ORDER BY id FOR UPDATE`, [accountId, absorbedId]);
  for (const x of lignes) {
    const rel = toRelation(x);
    const autre = rel.fromOperationId === absorbedId ? rel.toOperationId : rel.fromOperationId;
    if (autre === canonicalId) {
      // Les deux extrémités deviennent la même réalité : la relation active n'a plus d'objet (le refus reste en trace).
      if (rel.state === 'ACTIVE') {
        await setRelationState(r, accountId, rel.id, { state: 'REMOVED', origin: 'SYSTEM', reasonCode: 'MERGED_REFLEXIVE', userId: null });
        await journalGraph(r, accountId, { ...base, relationKind: 'OPERATION_RELATION', operationId: absorbedId, otherOperationId: canonicalId, action: 'REASSIGNED_ON_MERGE', before: { state: rel.state }, after: { state: 'REMOVED', reason: 'MERGED_REFLEXIVE' } });
        out.relationsDropped++;
      }
      continue;
    }
    const cible = await findRelation(r, accountId, canonicalId, autre);
    if (!cible) {
      const from = rel.fromOperationId === absorbedId ? canonicalId : rel.fromOperationId;
      const to = rel.toOperationId === absorbedId ? canonicalId : rel.toOperationId;
      const ends = orientRelation(rel.nature, from, to);
      await r.q(
        `UPDATE business_operation_relations SET from_operation_id = $3, to_operation_id = $4, version = version + 1, updated_at = now()
          WHERE id = $1 AND account_id = $2`, [rel.id, accountId, ends.fromOperationId, ends.toOperationId]);
      await journalGraph(r, accountId, { ...base, relationKind: 'OPERATION_RELATION', operationId: canonicalId, otherOperationId: autre, action: 'REASSIGNED_ON_MERGE', before: { operationId: absorbedId, state: rel.state }, after: { operationId: canonicalId, state: rel.state } });
      out.relationsMoved++;
      continue;
    }
    const etat = mergedRelationState(cible.state, rel.state);
    if (etat !== cible.state) {
      const from = rel.fromOperationId === absorbedId ? canonicalId : rel.fromOperationId;
      const to = rel.toOperationId === absorbedId ? canonicalId : rel.toOperationId;
      await updateRelation(r, accountId, cible.id, {
        ends: orientRelation(rel.nature, from, to), nature: rel.nature, state: etat, origin: rel.origin, reasonCode: 'OPERATION_MERGED',
        evidence: (Array.isArray(x.evidence) ? x.evidence : []) as GraphEvidence[], evidenceFingerprint: rel.evidenceFingerprint, userId: nOrNull(x.decided_by_user_id),
      });
      out.relationsMerged++;
    }
    if (rel.state === 'ACTIVE') await setRelationState(r, accountId, rel.id, { state: 'REMOVED', origin: 'SYSTEM', reasonCode: 'MERGED_INTO_CANONICAL', userId: null });
    await journalGraph(r, accountId, { ...base, relationKind: 'OPERATION_RELATION', operationId: canonicalId, otherOperationId: autre, action: 'REASSIGNED_ON_MERGE', before: { canonical: cible.state, absorbed: rel.state }, after: { canonical: etat } });
  }
  // Liens d'Agenda supplémentaires de l'absorbée : réactivés sur la canonique (sauf refus mémorisé), sinon déplacés.
  await r.q(
    `UPDATE business_operation_agenda_links c
        SET state = 'ACTIVE', ended_at = NULL, origin = a.origin, reason_code = 'OPERATION_MERGED', version = c.version + 1, updated_at = now()
       FROM business_operation_agenda_links a
      WHERE a.account_id = $1 AND a.operation_id = $2 AND a.state = 'ACTIVE' AND c.account_id = $1 AND c.operation_id = $3
        AND c.agenda_item_id = a.agenda_item_id AND c.state <> 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM business_operation_match_decisions d WHERE d.account_id = $1 AND d.candidate_operation_id = $3
                         AND d.source_kind = 'AGENDA' AND d.source_entity_key = a.agenda_item_id::text AND d.decision = 'REJECTED' AND d.active)`,
    [accountId, absorbedId, canonicalId]);
  await r.q(
    `UPDATE business_operation_agenda_links a
        SET state = 'REMOVED', legacy_column = false, ended_at = now(), reason_code = 'MERGED_INTO_CANONICAL', version = a.version + 1, updated_at = now()
      WHERE a.account_id = $1 AND a.operation_id = $2 AND a.state = 'ACTIVE'
        AND (EXISTS (SELECT 1 FROM business_operation_agenda_links c WHERE c.operation_id = $3 AND c.agenda_item_id = a.agenda_item_id)
             -- Refus mémorisé sur la canonique SANS ligne de lien (refus antérieur à la migration 1716) : jamais contourné par la fusion.
             OR EXISTS (SELECT 1 FROM business_operation_match_decisions d WHERE d.account_id = $1 AND d.candidate_operation_id = $3
                         AND d.source_kind = 'AGENDA' AND d.source_entity_key = a.agenda_item_id::text AND d.decision = 'REJECTED' AND d.active))`,
    [accountId, absorbedId, canonicalId]);
  const deplaces = await r.q<Row>(
    `UPDATE business_operation_agenda_links a SET operation_id = $3, reason_code = 'OPERATION_MERGED', version = a.version + 1, updated_at = now()
      WHERE a.account_id = $1 AND a.operation_id = $2 AND a.state = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links c WHERE c.operation_id = $3 AND c.agenda_item_id = a.agenda_item_id)
      RETURNING a.agenda_item_id`, [accountId, absorbedId, canonicalId]);
  for (const d of deplaces) {
    await journalGraph(r, accountId, { ...base, relationKind: 'AGENDA_LINK', operationId: canonicalId, otherOperationId: absorbedId, agendaItemId: n(d.agenda_item_id), action: 'REASSIGNED_ON_MERGE' });
  }
  out.agendaLinksMoved = deplaces.length;
  return out;
}

// ── Transfert d'un bien entre comptes (appelée par `detachCrossAccountGroupingInTx`) ──

const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

/**
 * Aucune relation du graphe ne franchit les comptes (CDC §4, §19, AC15, AC59).
 * Après le déplacement des Opérations et des éléments d'Agenda d'un bien :
 *   · une relation dont les DEUX extrémités sont arrivées dans le même autre
 *     compte les SUIT (elle change de compte avec elles) ;
 *   · une relation dont les extrémités sont désormais dans deux comptes est
 *     RETIRÉE (REMOVED, motif ACCOUNT_TRANSFER, tracée dans le compte quitté) —
 *     jamais lisible depuis l'un vers l'autre ;
 *   · les liens de la colonne historique sont resynchronisés.
 * Appelée dans la transaction du transfert (verrous des comptes détenus).
 */
export async function detachCrossAccountGraphInTx(r: GroupingRunner, accountIds: readonly number[]): Promise<{ relationsFollowed: number; relationsRemoved: number; agendaLinksFollowed: number; agendaLinksRemoved: number }> {
  const comptes = intArray(accountIds);
  const scopeRel = `(rel.account_id = ANY($1::int[]) OR f.account_id = ANY($1::int[]) OR t.account_id = ANY($1::int[]))`;
  const suivies = await r.q<Row>(
    `UPDATE business_operation_relations rel SET account_id = f.account_id, updated_at = now()
       FROM business_operations f, business_operations t
      WHERE f.id = rel.from_operation_id AND t.id = rel.to_operation_id AND f.account_id = t.account_id AND rel.account_id <> f.account_id AND ${scopeRel}
      RETURNING rel.id`, [comptes]);
  const retirees = await r.q<Row>(
    `UPDATE business_operation_relations rel
        SET state = 'REMOVED', ended_at = now(), origin = 'SYSTEM', reason_code = 'ACCOUNT_TRANSFER', version = rel.version + 1, updated_at = now()
       FROM business_operations f, business_operations t
      WHERE f.id = rel.from_operation_id AND t.id = rel.to_operation_id AND f.account_id <> t.account_id AND rel.state = 'ACTIVE' AND ${scopeRel}
      RETURNING rel.id, rel.account_id, rel.from_operation_id, rel.to_operation_id`, [comptes]);
  for (const x of retirees) {
    await journalGraph(r, n(x.account_id), { relationKind: 'OPERATION_RELATION', operationId: n(x.from_operation_id), otherOperationId: n(x.to_operation_id), action: 'ACCOUNT_TRANSFER', origin: 'SYSTEM', reasonCode: 'ACCOUNT_TRANSFER', before: { state: 'ACTIVE' }, after: { state: 'REMOVED' } });
  }
  const scopeLien = `(l.account_id = ANY($1::int[]) OR o.account_id = ANY($1::int[]) OR i.account_id = ANY($1::int[]))`;
  const liensSuivis = await r.q<Row>(
    `UPDATE business_operation_agenda_links l SET account_id = o.account_id, updated_at = now()
       FROM business_operations o, agenda_items i
      WHERE o.id = l.operation_id AND i.id = l.agenda_item_id AND o.account_id = i.account_id AND l.account_id <> o.account_id AND ${scopeLien}
      RETURNING l.id`, [comptes]);
  const liensRetires = await r.q<Row>(
    `UPDATE business_operation_agenda_links l
        SET state = 'REMOVED', legacy_column = false, ended_at = now(), origin = 'SYSTEM', reason_code = 'ACCOUNT_TRANSFER', version = l.version + 1, updated_at = now()
       FROM business_operations o, agenda_items i
      WHERE o.id = l.operation_id AND i.id = l.agenda_item_id AND o.account_id <> i.account_id AND l.state = 'ACTIVE' AND ${scopeLien}
      RETURNING l.id, l.account_id, l.operation_id, l.agenda_item_id`, [comptes]);
  for (const x of liensRetires) {
    await journalGraph(r, n(x.account_id), { relationKind: 'AGENDA_LINK', operationId: n(x.operation_id), agendaItemId: n(x.agenda_item_id), action: 'ACCOUNT_TRANSFER', origin: 'SYSTEM', reasonCode: 'ACCOUNT_TRANSFER', before: { state: 'ACTIVE' }, after: { state: 'REMOVED' } });
  }
  for (const a of [...new Set(accountIds)].sort((x, y) => x - y)) await resyncLegacyAgendaLinks(r, a);
  return { relationsFollowed: suivies.length, relationsRemoved: retirees.length, agendaLinksFollowed: liensSuivis.length, agendaLinksRemoved: liensRetires.length };
}

// ── Cohérence colonne historique ↔ graphe (réparation déterministe, idempotente) ──

/**
 * Remet le graphe à l'identique de la colonne historique pour UN compte
 * (même règle que le déclencheur 1716, pour les états qu'il n'a pas pu
 * refléter : couple transitoirement entre comptes pendant un transfert).
 * N'écrit que la table des liens ; ne touche ni l'élément d'Agenda, ni son
 * rôle, ni sa date, ni ses rappels. Rejouable sans effet.
 */
export async function resyncLegacyAgendaLinks(r: GroupingRunner, accountId: number): Promise<{ created: number; reactivated: number; released: number }> {
  const relaches = await r.q<Row>(
    `UPDATE business_operation_agenda_links l
        SET state = 'REMOVED', legacy_column = false, ended_at = now(), reason_code = 'LEGACY_COLUMN_DETACHED', version = l.version + 1, updated_at = now()
      WHERE l.account_id = $1 AND l.legacy_column
        AND NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = l.agenda_item_id AND i.account_id = $1 AND i.business_operation_id = l.operation_id)
      RETURNING l.id`, [accountId]);
  const poses = await r.q<Row>(
    `INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
     SELECT i.account_id, o.id, i.id, 'ACTIVE', 'SYSTEM', true, 'LEGACY_COLUMN_RESYNC'
       FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id
      WHERE i.account_id = $1 AND i.business_operation_id IS NOT NULL
     ON CONFLICT (operation_id, agenda_item_id) DO UPDATE
        SET state = 'ACTIVE', legacy_column = true, ended_at = NULL, account_id = EXCLUDED.account_id,
            version = business_operation_agenda_links.version + 1, updated_at = now()
      WHERE NOT (business_operation_agenda_links.state = 'ACTIVE' AND business_operation_agenda_links.legacy_column
                 AND business_operation_agenda_links.account_id = EXCLUDED.account_id)
     RETURNING (xmax = 0) AS inserted`, [accountId]);
  const created = poses.filter((p) => p.inserted === true).length;
  return { created, reactivated: poses.length - created, released: relaches.length };
}

export type GraphFindingCode =
  | 'RELATION_CROSS_ACCOUNT' | 'RELATION_ON_MERGED_OPERATION' | 'AGENDA_LINK_CROSS_ACCOUNT'
  | 'LEGACY_LINK_MISSING' | 'LEGACY_LINK_STALE' | 'AGENDA_LINK_ON_MERGED_OPERATION';

export interface GraphFinding { code: GraphFindingCode; count: number; sample: number[] }

const SAMPLE = 20;

/**
 * Contrôle d'intégrité du graphe d'UN compte — LECTURE SEULE. Les doublons et
 * les relations réflexives sont impossibles par construction (index unique,
 * CHECK). Rend les écarts restants : relation ou lien actif entre comptes,
 * relation ou lien actif resté sur une Opération fusionnée, colonne
 * historique sans lien du graphe (ou l'inverse). Compte sain : liste vide.
 */
export async function auditOperationGraph(r: GroupingRunner, accountId: number): Promise<GraphFinding[]> {
  const mesures: Array<[GraphFindingCode, string]> = [
    ['RELATION_CROSS_ACCOUNT',
      `SELECT rel.id FROM business_operation_relations rel
         JOIN business_operations f ON f.id = rel.from_operation_id JOIN business_operations t ON t.id = rel.to_operation_id
        WHERE rel.account_id = $1 AND rel.state = 'ACTIVE' AND (f.account_id <> rel.account_id OR t.account_id <> rel.account_id)`],
    ['RELATION_ON_MERGED_OPERATION',
      `SELECT rel.id FROM business_operation_relations rel
         JOIN business_operations f ON f.id = rel.from_operation_id JOIN business_operations t ON t.id = rel.to_operation_id
        WHERE rel.account_id = $1 AND rel.state = 'ACTIVE' AND (f.merged_into_operation_id IS NOT NULL OR t.merged_into_operation_id IS NOT NULL)`],
    ['AGENDA_LINK_CROSS_ACCOUNT',
      `SELECT l.id FROM business_operation_agenda_links l
         JOIN business_operations o ON o.id = l.operation_id JOIN agenda_items i ON i.id = l.agenda_item_id
        WHERE l.account_id = $1 AND l.state = 'ACTIVE' AND (o.account_id <> l.account_id OR i.account_id <> l.account_id)`],
    ['AGENDA_LINK_ON_MERGED_OPERATION',
      `SELECT l.id FROM business_operation_agenda_links l JOIN business_operations o ON o.id = l.operation_id
        WHERE l.account_id = $1 AND l.state = 'ACTIVE' AND o.merged_into_operation_id IS NOT NULL`],
    ['LEGACY_LINK_MISSING',
      `SELECT i.id FROM agenda_items i JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id
        WHERE i.account_id = $1 AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links l
                WHERE l.operation_id = i.business_operation_id AND l.agenda_item_id = i.id AND l.account_id = i.account_id AND l.state = 'ACTIVE')`],
    ['LEGACY_LINK_STALE',
      `SELECT l.id FROM business_operation_agenda_links l
        WHERE l.account_id = $1 AND l.legacy_column
          AND NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = l.agenda_item_id AND i.account_id = $1 AND i.business_operation_id = l.operation_id)`],
  ];
  const out: GraphFinding[] = [];
  for (const [code, text] of mesures) {
    const x = await r.q<Row>(`${text} ORDER BY 1`, [accountId]);
    if (x.length) out.push({ code, count: x.length, sample: x.slice(0, SAMPLE).map((y) => n(y.id)) });
  }
  return out;
}
