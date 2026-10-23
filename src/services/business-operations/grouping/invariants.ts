/**
 * Invariants du regroupement v5 (lot 82D, CDC v5 O-1) — DÉCLARÉS pour le
 * registre de contrôles de cohérence (chantier 82B, arbitrage C-Q11 : chaque
 * évolution livre ses contrôles). Aucun orchestrateur ici : le registre
 * appelle `detect` (lecture seule, aucune écriture) puis, pour un constat
 * réparable, `repair` — qui passe EXCLUSIVEMENT par le service unique de
 * regroupement (C-Q2 : réparation par les services métier existants ;
 * jamais d'écriture arbitraire). Éligibilité des comptes (C-Q10) : de la
 * responsabilité de l'orchestrateur (fonction d'éligibilité de 82A) — ces
 * fonctions ne la revérifient pas.
 *
 *   id                         niveau  réparation      objet
 *   O1-PRINCIPAL-UNIQUE        N1      DÉTERMINISTE    au plus un principal par Opération
 *   O1-AGENDA-ONE-OPERATION    N1      DÉTERMINISTE    0..1 Opération ACTIVE du MÊME compte par
 *                                                      élément ; rôle ⇔ appartenance
 *   O1-LINK-PROVENANCE         N1      DÉTERMINISTE    tout lien Document ↔ Agenda a ≥ 1 provenance
 *   O1-PRINCIPAL-DOCUMENTS     N2      DÉTERMINISTE    P4 : documents membres liés au principal ;
 *                                                      aucune propagation hors du principal
 *   O1-DOCUMENT-MEMBERSHIP     N2      DÉTERMINISTE    appartenance SOURCE = sources DOCUMENT actives
 *   O1-ANTI-CARTESIAN          N2      CONSTAT SEUL    aucun produit Documents × Équipements
 *                                                      automatique (P19, AC50)
 *
 * Les évaluateurs `evaluate*` sont PURS (instantanés en entrée) : testables
 * sans base, réutilisables par l'export de diagnostic. `detect` charge
 * l'instantané d'un compte (borné aux Opérations demandées si fournies) puis
 * évalue. Idempotence : un état conforme rend une liste vide ; une réparation
 * rejouée n'écrit rien.
 */
import { detectCartesian, inferredProvenance, planPrincipalLinks, type OperationRole } from './model';
import { addFileLinkProvenance } from './provenance';
import { recomputePrincipal, stripPrincipalLinks } from './principal';
import { intArray, lockGroupingAccount, type GroupingRunner } from './runner';
import { attachAgendaItem, detachAgendaItem, type GroupingContext } from './service';

export const GROUPING_INVARIANTS_VERSION = 'l82d-v1';

export type GroupingInvariantId =
  | 'O1-PRINCIPAL-UNIQUE' | 'O1-AGENDA-ONE-OPERATION' | 'O1-LINK-PROVENANCE'
  | 'O1-PRINCIPAL-DOCUMENTS' | 'O1-DOCUMENT-MEMBERSHIP' | 'O1-ANTI-CARTESIAN';

export interface GroupingFinding {
  invariantId: GroupingInvariantId;
  accountId: number;
  /** Clé stable de l'objet (empreinte du constat avec l'invariant et la nature). */
  objectKey: string;
  nature: string;
  detail: Record<string, unknown>;
  repairable: boolean;
}

/**
 * Résultat d'une réparation : `repaired` — l'écart ne tient plus (une
 * réparation antérieure en cascade, ou rejouée, rend `repaired: true` sans
 * écriture) ; `changed` — la réparation a écrit. Le registre recontrôle
 * ensuite par `detect` (C-Q2 : un nouveau contrôle valide la cohérence).
 */
export interface GroupingRepairOutcome { repaired: boolean; changed: boolean; detail?: Record<string, unknown> }

export interface GroupingInvariant {
  id: GroupingInvariantId;
  version: number;
  domain: 'operations';
  level: 'N1' | 'N2';
  objects: readonly string[];
  description: string;
  repair: 'DETERMINISTIC' | 'DETECT_ONLY';
  detect(r: GroupingRunner, accountId: number, scope?: { operationIds?: readonly number[] }): Promise<GroupingFinding[]>;
  /** Réparation par le service de regroupement (dans une transaction ouverte par l'orchestrateur). */
  repairFinding?(ctx: GroupingContext, f: GroupingFinding): Promise<GroupingRepairOutcome>;
}

// ── Évaluateurs purs ───────────────────────────────────────────────────────

export interface AgendaMembershipRow {
  itemId: number;
  accountId: number;
  operationId: number | null;
  role: OperationRole | null;
  /** Opération introuvable : null. */
  operationAccountId: number | null;
  operationActive: boolean | null;
  mergedInto: number | null;
}

export function evaluatePrincipalUniqueness(accountId: number, rows: readonly AgendaMembershipRow[]): GroupingFinding[] {
  const par = new Map<number, number[]>();
  for (const r of rows) if (r.operationId !== null && r.role === 'PRINCIPAL') par.set(r.operationId, [...(par.get(r.operationId) ?? []), r.itemId]);
  return [...par].filter(([, ids]) => ids.length > 1).map(([op, ids]) => ({
    invariantId: 'O1-PRINCIPAL-UNIQUE', accountId, objectKey: `operation:${op}`, nature: 'MULTIPLE_PRINCIPALS',
    detail: { operationId: op, itemIds: ids.sort((a, b) => a - b) }, repairable: true,
  }));
}

export function evaluateAgendaMembership(accountId: number, rows: readonly AgendaMembershipRow[]): GroupingFinding[] {
  const out: GroupingFinding[] = [];
  const f = (r: AgendaMembershipRow, nature: string, detail: Record<string, unknown> = {}): GroupingFinding => ({
    invariantId: 'O1-AGENDA-ONE-OPERATION', accountId, objectKey: `agenda_item:${r.itemId}`, nature,
    detail: { itemId: r.itemId, operationId: r.operationId, role: r.role, ...detail }, repairable: true,
  });
  for (const r of rows) {
    if (r.operationId === null) {
      if (r.role !== null) out.push(f(r, 'ROLE_WITHOUT_OPERATION'));
      continue;
    }
    if (r.operationAccountId === null) out.push(f(r, 'OPERATION_MISSING'));
    else if (r.operationAccountId !== r.accountId) out.push(f(r, 'CROSS_ACCOUNT', { operationAccountId: r.operationAccountId }));
    else if (r.mergedInto !== null) out.push(f(r, 'MERGED_OPERATION', { canonicalId: r.mergedInto }));
    else if (r.operationActive === false) out.push(f(r, 'INACTIVE_OPERATION'));
    else if (r.role === null) out.push(f(r, 'OPERATION_WITHOUT_ROLE'));
  }
  return out;
}

export interface FileLinkRow { itemId: number; fileId: number; provenances: readonly string[]; projected: boolean; isAutomatic: boolean; role: OperationRole | null }

export function evaluateLinkProvenance(accountId: number, rows: readonly FileLinkRow[]): GroupingFinding[] {
  return rows.filter((r) => !r.provenances.length).map((r) => ({
    invariantId: 'O1-LINK-PROVENANCE', accountId, objectKey: `agenda_file_link:${r.itemId}:${r.fileId}`, nature: 'EMPTY_PROVENANCE',
    detail: { itemId: r.itemId, fileId: r.fileId, inferred: inferredProvenance({ projected: r.projected, isAutomatic: r.isAutomatic, role: r.role }) },
    repairable: true,
  }));
}

export interface OperationPrincipalSnapshot {
  operationId: number;
  principalItemId: number | null;
  memberItemIds: readonly number[];
  memberFileIds: readonly number[];
  rejectedFileIds: readonly number[];
  links: ReadonlyArray<{ itemId: number; fileId: number; provenances: readonly string[] }>;
}

export function evaluatePrincipalDocuments(accountId: number, ops: readonly OperationPrincipalSnapshot[]): GroupingFinding[] {
  const out: GroupingFinding[] = [];
  for (const o of ops) {
    const plan = planPrincipalLinks(o);
    if (plan.add.length || plan.remove.length) {
      out.push({
        invariantId: 'O1-PRINCIPAL-DOCUMENTS', accountId, objectKey: `operation:${o.operationId}`,
        nature: plan.add.length ? 'MISSING_PRINCIPAL_LINK' : 'STRAY_PRINCIPAL_LINK',
        detail: { operationId: o.operationId, principalItemId: o.principalItemId, add: plan.add, remove: plan.remove }, repairable: true,
      });
    }
  }
  return out;
}

/** Propagation résiduelle sur un élément qui n'est principal d'AUCUNE Opération active. */
export function evaluateStrayPrincipalProvenance(accountId: number, rows: ReadonlyArray<{ itemId: number; fileIds: readonly number[] }>): GroupingFinding[] {
  return rows.map((r) => ({
    invariantId: 'O1-PRINCIPAL-DOCUMENTS' as const, accountId, objectKey: `agenda_item:${r.itemId}`, nature: 'STRAY_PRINCIPAL_LINK',
    detail: { itemId: r.itemId, fileIds: [...r.fileIds].sort((a, b) => a - b) }, repairable: true,
  }));
}

export function evaluateDocumentMembership(
  accountId: number, rows: ReadonlyArray<{ operationId: number; fileId: number; hasSourceOrigin: boolean; hasActiveSource: boolean }>,
): GroupingFinding[] {
  return rows.filter((r) => r.hasSourceOrigin !== r.hasActiveSource).map((r) => ({
    invariantId: 'O1-DOCUMENT-MEMBERSHIP', accountId, objectKey: `operation_document:${r.operationId}:${r.fileId}`,
    nature: r.hasActiveSource ? 'MISSING_SOURCE_MEMBERSHIP' : 'STALE_SOURCE_MEMBERSHIP',
    detail: { operationId: r.operationId, fileId: r.fileId }, repairable: true,
  }));
}

export function evaluateAntiCartesian(
  accountId: number,
  ops: ReadonlyArray<{ operationId: number; memberFileIds: readonly number[]; equipmentIds: readonly number[]; links: ReadonlyArray<{ fileId: number; equipmentId: number; userOrigin: boolean }> }>,
): GroupingFinding[] {
  return ops.flatMap((o) => {
    const c = detectCartesian(o);
    return c.cartesian ? [{
      invariantId: 'O1-ANTI-CARTESIAN' as const, accountId, objectKey: `operation:${o.operationId}`, nature: 'CARTESIAN_DOCUMENT_EQUIPMENT',
      detail: { operationId: o.operationId, documents: o.memberFileIds.length, equipments: o.equipmentIds.length, pairs: c.pairs }, repairable: false,
    }] : [];
  });
}

// ── Chargement des instantanés (lecture seule) ─────────────────────────────

const opFilter = (scope?: { operationIds?: readonly number[] }) => (scope?.operationIds?.length ? intArray(scope.operationIds) : null);

async function loadMemberships(r: GroupingRunner, accountId: number, scope?: { operationIds?: readonly number[] }): Promise<AgendaMembershipRow[]> {
  const x = await r.q<{ id: number; account_id: number; op: string | null; role: OperationRole | null; op_account: number | null; active: boolean | null; merged: string | null }>(
    `SELECT i.id, i.account_id, i.business_operation_id AS op, i.operation_role AS role, o.account_id AS op_account,
            (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active, o.merged_into_operation_id AS merged
       FROM agenda_items i LEFT JOIN business_operations o ON o.id = i.business_operation_id
      WHERE i.account_id = $1 AND (i.business_operation_id IS NOT NULL OR i.operation_role IS NOT NULL)
        AND ($2::bigint[] IS NULL OR i.business_operation_id = ANY($2::bigint[]))
      ORDER BY i.id`,
    [accountId, opFilter(scope)]);
  return x.map((y) => ({
    itemId: Number(y.id), accountId: Number(y.account_id), operationId: y.op === null ? null : Number(y.op), role: y.role,
    operationAccountId: y.op_account === null ? null : Number(y.op_account), operationActive: y.active, mergedInto: y.merged === null ? null : Number(y.merged),
  }));
}

async function loadPrincipalSnapshots(r: GroupingRunner, accountId: number, scope?: { operationIds?: readonly number[] }): Promise<OperationPrincipalSnapshot[]> {
  const ops = await r.q<{ id: string; principal: number | null; items: number[] | null; files: number[] | null; rejected: string[] | null }>(
    `SELECT o.id,
            (SELECT min(i.id) FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id AND i.operation_role = 'PRINCIPAL') AS principal,
            (SELECT array_agg(i.id ORDER BY i.id) FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id) AS items,
            (SELECT array_agg(d.file_id ORDER BY d.file_id) FROM business_operation_documents d JOIN asset_files f ON f.id = d.file_id AND f.deleted_at IS NULL
              WHERE d.operation_id = o.id AND d.active) AS files,
            (SELECT array_agg(m.source_entity_key) FROM business_operation_match_decisions m
              WHERE m.candidate_operation_id = o.id AND m.active AND m.source_kind = 'PRINCIPAL_LINK' AND m.decision = 'REJECTED') AS rejected
       FROM business_operations o
      WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND ($2::bigint[] IS NULL OR o.id = ANY($2::bigint[]))
        AND EXISTS (SELECT 1 FROM agenda_items i WHERE i.business_operation_id = o.id)
      ORDER BY o.id`,
    [accountId, opFilter(scope)]);
  const itemIds = ops.flatMap((o) => (o.items ?? []).map(Number));
  const links = itemIds.length ? await r.q<{ item_id: number; file_id: number; provenances: string[] }>(
    `SELECT agenda_item_id AS item_id, asset_file_id AS file_id, provenances FROM agenda_file_links WHERE agenda_item_id = ANY($1::int[])`, [intArray(itemIds)]) : [];
  return ops.map((o) => {
    const items = new Set((o.items ?? []).map(Number));
    return {
      operationId: Number(o.id), principalItemId: o.principal === null ? null : Number(o.principal), memberItemIds: [...items],
      memberFileIds: (o.files ?? []).map(Number), rejectedFileIds: (o.rejected ?? []).map(Number),
      links: links.filter((l) => items.has(Number(l.item_id))).map((l) => ({ itemId: Number(l.item_id), fileId: Number(l.file_id), provenances: l.provenances ?? [] })),
    };
  });
}

// ── Registre ───────────────────────────────────────────────────────────────

export const OPERATIONS_GROUPING_INVARIANTS: readonly GroupingInvariant[] = [
  {
    id: 'O1-PRINCIPAL-UNIQUE', version: 1, domain: 'operations', level: 'N1', objects: ['agenda_items', 'business_operations'], repair: 'DETERMINISTIC',
    description: 'Au plus un élément d’agenda principal par Opération (CDC v5 §27.2). Réparation : rétrogradation des excédents par rang d’autorité (USER > T4 > T3 > SYSTEM) puis ancienneté, propagation recalculée.',
    detect: async (r, accountId, scope) => evaluatePrincipalUniqueness(accountId, await loadMemberships(r, accountId, scope)),
    repairFinding: async (ctx, f) => {
      const res = await recomputePrincipalFor(ctx, Number(f.detail.operationId));
      return { repaired: true, changed: res.demoted.length + res.added + res.removed > 0, detail: { demoted: res.demoted } };
    },
  },
  {
    id: 'O1-AGENDA-ONE-OPERATION', version: 1, domain: 'operations', level: 'N1', objects: ['agenda_items'], repair: 'DETERMINISTIC',
    description: 'Un élément d’agenda appartient à 0 ou 1 Opération ACTIVE de son compte, avec un rôle ; hors Opération, aucun rôle (CDC v5 §6.1, E26). Réparation : rattachement à la canonique d’une Opération fusionnée, détachement d’une Opération invalidée, introuvable ou d’un autre compte, rôle remis en cohérence.',
    detect: async (r, accountId, scope) => evaluateAgendaMembership(accountId, await loadMemberships(r, accountId, scope)),
    repairFinding: async (ctx, f) => {
      const itemId = Number(f.detail.itemId);
      await lockGroupingAccount(ctx.runner, ctx.accountId);
      switch (f.nature) {
        case 'MERGED_OPERATION': {
          const res = await attachAgendaItem(ctx, { operationId: Number(f.detail.canonicalId), itemId, origin: 'SYSTEM', reasonCode: 'COHERENCE_MERGED_OPERATION' });
          const [x] = await ctx.runner.q<{ op: string | null }>(`SELECT business_operation_id AS op FROM agenda_items WHERE id = $1`, [itemId]);
          return { repaired: x !== undefined && Number(x.op) === Number(f.detail.canonicalId), changed: res.changed, detail: { ...res } };
        }
        case 'INACTIVE_OPERATION':
        case 'OPERATION_MISSING':
        case 'CROSS_ACCOUNT': {
          const res = await detachAgendaItem(ctx, { itemId, operationId: Number(f.detail.operationId), origin: 'SYSTEM', reasonCode: `COHERENCE_${f.nature}` });
          return { repaired: true, changed: res.changed };
        }
        case 'ROLE_WITHOUT_OPERATION': {
          const x = await ctx.runner.q(`UPDATE agenda_items SET operation_role = NULL, operation_role_origin = NULL WHERE id = $1 AND account_id = $2 AND business_operation_id IS NULL AND operation_role IS NOT NULL RETURNING id`, [itemId, ctx.accountId]);
          return { repaired: true, changed: x.length > 0 };
        }
        case 'OPERATION_WITHOUT_ROLE': {
          const x = await ctx.runner.q(`UPDATE agenda_items SET operation_role = 'RELATED', operation_role_origin = 'SYSTEM' WHERE id = $1 AND account_id = $2 AND operation_role IS NULL AND business_operation_id IS NOT NULL RETURNING id`, [itemId, ctx.accountId]);
          return { repaired: true, changed: x.length > 0 };
        }
        default:
          return { repaired: false, changed: false };
      }
    },
  },
  {
    id: 'O1-LINK-PROVENANCE', version: 1, domain: 'operations', level: 'N1', objects: ['agenda_file_links'], repair: 'DETERMINISTIC',
    description: 'Tout lien Document ↔ Agenda porte au moins une provenance MANUAL_DIRECT, AI_DIRECT ou OPERATION_PRINCIPAL (CDC v5 §7.4). Réparation : provenance déduite de l’origine de l’élément (règle de la reprise 0654).',
    detect: async (r, accountId) => {
      const x = await r.q<{ item_id: number; file_id: number; provenances: string[]; projected: boolean; is_automatic: boolean; role: OperationRole | null }>(
        `SELECT l.agenda_item_id AS item_id, l.asset_file_id AS file_id, l.provenances, i.projection_origin IS NOT NULL AS projected, i.is_automatic, i.operation_role AS role
           FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
          WHERE i.account_id = $1 AND cardinality(l.provenances) = 0 ORDER BY 1, 2`, [accountId]);
      return evaluateLinkProvenance(accountId, x.map((y) => ({ itemId: Number(y.item_id), fileId: Number(y.file_id), provenances: y.provenances ?? [], projected: y.projected, isAutomatic: y.is_automatic, role: y.role })));
    },
    repairFinding: async (ctx, f) => {
      await lockGroupingAccount(ctx.runner, ctx.accountId);
      const n = await addFileLinkProvenance(ctx.runner, Number(f.detail.itemId), [Number(f.detail.fileId)], f.detail.inferred as never);
      return { repaired: true, changed: n > 0 };
    },
  },
  {
    id: 'O1-PRINCIPAL-DOCUMENTS', version: 1, domain: 'operations', level: 'N2', objects: ['agenda_file_links', 'business_operation_documents'], repair: 'DETERMINISTIC',
    description: 'P4 : quand une Opération a un principal, chacun de ses documents (non refusé par l’utilisateur) lui est lié (OPERATION_PRINCIPAL) ; aucune propagation sur un élément qui n’est pas principal. Réparation : recomputePrincipal (premier maillon, sans reconsolidation).',
    detect: async (r, accountId, scope) => {
      const ops = evaluatePrincipalDocuments(accountId, await loadPrincipalSnapshots(r, accountId, scope));
      const errants = await r.q<{ item_id: number; files: number[] }>(
        `SELECT l.agenda_item_id AS item_id, array_agg(l.asset_file_id ORDER BY l.asset_file_id) AS files
           FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
           LEFT JOIN business_operations o ON o.id = i.business_operation_id
          WHERE i.account_id = $1 AND 'OPERATION_PRINCIPAL' = ANY(l.provenances)
            AND (i.business_operation_id IS NULL OR i.operation_role IS DISTINCT FROM 'PRINCIPAL'
                 OR o.invalidated_at IS NOT NULL OR o.merged_into_operation_id IS NOT NULL)
            AND ($2::bigint[] IS NULL OR i.business_operation_id IS NULL OR i.business_operation_id = ANY($2::bigint[]))
          GROUP BY l.agenda_item_id ORDER BY 1`, [accountId, opFilter(scope)]);
      const dejaVus = new Set(ops.flatMap((o) => ((o.detail.remove as Array<{ itemId: number }>) ?? []).map((x) => x.itemId)));
      return [...ops, ...evaluateStrayPrincipalProvenance(accountId,
        errants.filter((e) => !dejaVus.has(Number(e.item_id))).map((e) => ({ itemId: Number(e.item_id), fileIds: (e.files ?? []).map(Number) })))];
    },
    repairFinding: async (ctx, f) => {
      if (f.detail.operationId != null) {
        const res = await recomputePrincipalFor(ctx, Number(f.detail.operationId));
        return { repaired: true, changed: res.added + res.removed > 0, detail: { added: res.added, removed: res.removed } };
      }
      await lockGroupingAccount(ctx.runner, ctx.accountId);
      const n = await stripPrincipalLinks(ctx.runner, [Number(f.detail.itemId)]);
      return { repaired: true, changed: n > 0 };
    },
  },
  {
    id: 'O1-DOCUMENT-MEMBERSHIP', version: 1, domain: 'operations', level: 'N2', objects: ['business_operation_documents', 'business_operation_sources'], repair: 'DETERMINISTIC',
    description: 'L’appartenance SOURCE d’un document à une Opération reflète exactement ses sources DOCUMENT actives (déclencheur 0655). Réparation : recalcul de l’appartenance du couple par la fonction de la base.',
    detect: async (r, accountId, scope) => {
      const x = await r.q<{ op: string; file_id: number; has_origin: boolean; has_source: boolean }>(
        `WITH sources AS (
           SELECT DISTINCT s.operation_id AS op, f.id AS file_id FROM business_operation_sources s
             JOIN asset_files f ON f.id::text = s.source_entity_key AND f.account_id = s.account_id
            WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[1-9][0-9]{0,9}$'
         ), membres AS (
           SELECT operation_id AS op, file_id FROM business_operation_documents WHERE account_id = $1 AND 'SOURCE' = ANY(origins)
         )
         SELECT COALESCE(s.op, m.op) AS op, COALESCE(s.file_id, m.file_id) AS file_id, m.op IS NOT NULL AS has_origin, s.op IS NOT NULL AS has_source
           FROM sources s FULL JOIN membres m ON m.op = s.op AND m.file_id = s.file_id
          WHERE (s.op IS NULL OR m.op IS NULL) AND ($2::bigint[] IS NULL OR COALESCE(s.op, m.op) = ANY($2::bigint[]))
          ORDER BY 1, 2`, [accountId, opFilter(scope)]);
      return evaluateDocumentMembership(accountId, x.map((y) => ({ operationId: Number(y.op), fileId: Number(y.file_id), hasSourceOrigin: y.has_origin, hasActiveSource: y.has_source })));
    },
    repairFinding: async (ctx, f) => {
      await lockGroupingAccount(ctx.runner, ctx.accountId);
      const lire = () => ctx.runner.q<{ o: string[] }>(`SELECT origins AS o FROM business_operation_documents WHERE operation_id = $1 AND file_id = $2`, [Number(f.detail.operationId), Number(f.detail.fileId)]);
      const avant = JSON.stringify(await lire());
      await ctx.runner.q(`SELECT business_operation_documents_refresh($1::int, $2::bigint, $3::text)`, [ctx.accountId, Number(f.detail.operationId), String(f.detail.fileId)]);
      const r = await recomputePrincipal(ctx.runner, ctx.accountId, Number(f.detail.operationId));
      return { repaired: true, changed: avant !== JSON.stringify(await lire()) || r.added + r.removed > 0 };
    },
  },
  {
    id: 'O1-ANTI-CARTESIAN', version: 1, domain: 'operations', level: 'N2', objects: ['document_asset_links', 'business_operation_equipment_links'], repair: 'DETECT_ONLY',
    description: 'P19 / AC50 : l’appartenance commune à une Opération n’est jamais une preuve qu’un document concerne un équipement. Constat : tous les documents (≥ 2) liés automatiquement à tous les équipements (≥ 2) de l’Opération. Aucune réparation automatique (C-Q2 : rien n’est retiré sans preuve) ; la reconsolidation ciblée (O-6) réévalue document par document.',
    detect: async (r, accountId, scope) => {
      const x = await r.q<{ op: string; files: number[] | null; equips: number[] | null; links: Array<{ f: number; e: number; u: boolean }> | null }>(
        `SELECT o.id AS op,
                (SELECT array_agg(d.file_id) FROM business_operation_documents d WHERE d.operation_id = o.id AND d.active) AS files,
                (SELECT array_agg(el.equipment_id) FROM business_operation_equipment_links el WHERE el.operation_id = o.id AND el.active) AS equips,
                (SELECT jsonb_agg(jsonb_build_object('f', l.file_id, 'e', l.equipment_id, 'u', l.origin = 'USER'))
                   FROM document_asset_links l
                  WHERE l.account_id = o.account_id AND l.status = 'ACTIVE' AND l.equipment_id IS NOT NULL
                    AND l.file_id IN (SELECT d.file_id FROM business_operation_documents d WHERE d.operation_id = o.id AND d.active)
                    AND l.equipment_id IN (SELECT el.equipment_id FROM business_operation_equipment_links el WHERE el.operation_id = o.id AND el.active)) AS links
           FROM business_operations o
          WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
            AND ($2::bigint[] IS NULL OR o.id = ANY($2::bigint[]))
            AND (SELECT count(*) FROM business_operation_equipment_links el WHERE el.operation_id = o.id AND el.active) >= 2
          ORDER BY o.id`, [accountId, opFilter(scope)]);
      return evaluateAntiCartesian(accountId, x.map((y) => ({
        operationId: Number(y.op), memberFileIds: (y.files ?? []).map(Number), equipmentIds: (y.equips ?? []).map(Number),
        links: (y.links ?? []).map((l) => ({ fileId: Number(l.f), equipmentId: Number(l.e), userOrigin: !!l.u })),
      })));
    },
  },
];

async function recomputePrincipalFor(ctx: GroupingContext, operationId: number) {
  await lockGroupingAccount(ctx.runner, ctx.accountId);
  return recomputePrincipal(ctx.runner, ctx.accountId, operationId);
}

/** Détection complète d'un compte (tous les invariants), dans l'ordre du registre. */
export async function detectGroupingFindings(r: GroupingRunner, accountId: number, scope?: { operationIds?: readonly number[] }): Promise<GroupingFinding[]> {
  const out: GroupingFinding[] = [];
  for (const inv of OPERATIONS_GROUPING_INVARIANTS) out.push(...await inv.detect(r, accountId, scope));
  return out;
}

/** Répare un constat par l'invariant qui l'a produit (aucune réparation pour un constat seul). */
export async function repairGroupingFinding(ctx: GroupingContext, f: GroupingFinding): Promise<GroupingRepairOutcome> {
  const inv = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === f.invariantId);
  if (!inv?.repairFinding || !f.repairable || f.accountId !== ctx.accountId) return { repaired: false, changed: false };
  return inv.repairFinding(ctx, f);
}

