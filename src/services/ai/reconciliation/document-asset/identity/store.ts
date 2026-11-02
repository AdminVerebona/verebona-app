/**
 * Persistance des groupes d'identité documentaire (journal / supervision) et
 * des décisions de l'utilisateur — tables 0995 (lot 105D).
 *
 * Les groupes ne sont qu'un INSTANTANÉ recalculé : la source métier reste
 * liens, résolutions T3 et faits. Les décisions sont durables et prioritaires
 * (une seule ACTIVE par compte × groupe × bien ; remplacée → SUPERSEDED,
 * annulée → UNDONE, avec motif). Tolérant : table absente → aucune écriture
 * (journalisé), jamais une erreur pour T3.
 */
import { pgClient } from '@/db';
import type { IdentityGroup } from './graph';

type Sql = Pick<typeof pgClient, 'unsafe'>;

/** Enregistre l'état courant des groupes du compte et retire (inactifs) ceux qui ont disparu. Rend le nombre de groupes modifiés. */
export async function persistGroups(accountId: number, groups: readonly IdentityGroup[], opts: { cards?: ReadonlyMap<string, number | null>; sql?: Sql } = {}): Promise<number> {
  const sql = opts.sql ?? pgClient;
  let changed = 0;
  for (const g of groups) {
    const rows = (await sql.unsafe(
      `INSERT INTO document_identity_groups (account_id, group_key, identity_family, identity_kinds, identity_label, engine_version, fingerprint, status,
                                             member_file_ids, anchor_file_ids, members, excluded, edges, evidence, contradictions,
                                             target_asset_id, candidate_asset_ids, refused_asset_ids, card_action_id, active, last_evaluation)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9::int[], $10::int[], $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
               $16, $17::int[], $18::int[], $19, true, $20::jsonb)
       ON CONFLICT (account_id, group_key) DO UPDATE SET
         identity_family = EXCLUDED.identity_family, identity_kinds = EXCLUDED.identity_kinds, identity_label = EXCLUDED.identity_label,
         engine_version = EXCLUDED.engine_version, status = EXCLUDED.status, member_file_ids = EXCLUDED.member_file_ids,
         anchor_file_ids = EXCLUDED.anchor_file_ids, members = EXCLUDED.members, excluded = EXCLUDED.excluded, edges = EXCLUDED.edges,
         evidence = EXCLUDED.evidence, contradictions = EXCLUDED.contradictions, target_asset_id = EXCLUDED.target_asset_id,
         candidate_asset_ids = EXCLUDED.candidate_asset_ids, refused_asset_ids = EXCLUDED.refused_asset_ids,
         card_action_id = COALESCE(EXCLUDED.card_action_id, CASE WHEN EXCLUDED.status = 'TO_CONFIRM' THEN document_identity_groups.card_action_id END),
         active = true, last_evaluation = EXCLUDED.last_evaluation, evaluated_at = now(),
         changed_at = CASE WHEN document_identity_groups.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint OR NOT document_identity_groups.active
                           THEN now() ELSE document_identity_groups.changed_at END,
         fingerprint = EXCLUDED.fingerprint
       RETURNING (xmax = 0) AS inserted, changed_at = evaluated_at AS modifie`,
      [
        accountId, g.groupKey, g.family, g.kinds, g.label.slice(0, 200), 1, g.fingerprint, g.status,
        g.members.map((m) => m.fileId), g.anchors.map((a) => a.fileId),
        JSON.stringify(g.members), JSON.stringify(g.excluded), JSON.stringify(g.edges.slice(0, 200)),
        // Provenance SANS valeur (clé normalisée et extrait restent côté calcul) : document, nature, rôle, champ, origine, fiabilité.
        JSON.stringify(g.evidence.slice(0, 200).map((s) => ({ ref: s.ref, fileId: s.fileId, family: s.family, kind: s.kind, role: s.role, field: s.field, origin: s.origin, unitIds: s.unitIds ?? [], reliability: s.reliability, normalization: s.normalization }))),
        JSON.stringify(g.contradictions), g.targetAssetId, g.candidateAssetIds, g.refusedAssetIds, opts.cards?.get(g.groupKey) ?? null,
        JSON.stringify({ at: new Date().toISOString(), cardEligible: g.cardEligible, decisionIds: g.decisionIds }),
      ] as never[],
    )) as unknown as Array<{ inserted: boolean; modifie: boolean }>;
    if (rows[0]?.inserted || rows[0]?.modifie) changed += 1;
  }
  await sql.unsafe(
    `UPDATE document_identity_groups SET active = false, changed_at = now(), card_action_id = NULL
      WHERE account_id = $1 AND active AND NOT (group_key = ANY($2::text[]))`,
    [accountId, groups.map((g) => g.groupKey)] as never[],
  );
  return changed;
}

export interface GroupDecisionInput {
  accountId: number;
  groupKey: string;
  assetId: number;
  decision: 'CONFIRMED' | 'REFUSED';
  contextFingerprint: string;
  groupFingerprint: string | null;
  memberFileIds: number[];
  userId: number | null;
  actionId: number | null;
}

/**
 * Enregistre une décision ACTIVE (remplace la précédente pour le même
 * couple groupe × bien, SUPERSEDED avec motif). Rend l'identifiant.
 */
export async function recordGroupDecision(d: GroupDecisionInput, sql: Sql = pgClient): Promise<number> {
  await sql.unsafe(
    `UPDATE document_identity_decisions SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = $4
      WHERE account_id = $1 AND group_key = $2 AND asset_id = $3 AND status = 'ACTIVE'`,
    [d.accountId, d.groupKey, d.assetId, `NEW_USER_DECISION:${d.decision}`] as never[],
  );
  const [r] = (await sql.unsafe(
    `INSERT INTO document_identity_decisions (account_id, group_key, asset_id, decision, context_fingerprint, group_fingerprint, member_file_ids, decided_by_user_id, action_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::int[], $8, $9) RETURNING id`,
    [d.accountId, d.groupKey, d.assetId, d.decision, d.contextFingerprint, d.groupFingerprint, d.memberFileIds, d.userId, d.actionId] as never[],
  )) as unknown as Array<{ id: number }>;
  return Number(r.id);
}

/** Annule les décisions prises par une carte (« Annuler ») : UNDONE. Rend les décisions annulées. */
export async function undoGroupDecisions(accountId: number, actionId: number, sql: Sql = pgClient): Promise<Array<{ id: number; assetId: number; decision: string; groupKey: string; createdAt: string }>> {
  const rows = (await sql.unsafe(
    `UPDATE document_identity_decisions SET status = 'UNDONE', superseded_at = now(), superseded_reason = 'USER_UNDO'
      WHERE account_id = $1 AND action_id = $2 AND status = 'ACTIVE'
      RETURNING id, asset_id, decision, group_key, created_at`,
    [accountId, actionId] as never[],
  )) as unknown as Array<{ id: number; asset_id: number; decision: string; group_key: string; created_at: string | Date }>;
  return rows.map((r) => ({ id: Number(r.id), assetId: Number(r.asset_id), decision: r.decision, groupKey: r.group_key, createdAt: new Date(r.created_at).toISOString() }));
}

/** Signal de connaissance (journal 0292) : une décision d'identité rend les décisions ouvertes du compte réévaluables. */
export async function noteIdentityKnowledgeChange(accountId: number, actionId: number | null, sql: Sql = pgClient): Promise<void> {
  await sql.unsafe(
    `INSERT INTO account_knowledge_changes (account_id, kind, object_type, object_id) VALUES ($1, 'ARBITRATION', 'identity_group', $2)`,
    [accountId, actionId] as never[],
  ).catch((e) => console.error(`[t3-identity] journal de connaissance du compte ${accountId} non alimenté :`, (e as Error).message));
}
