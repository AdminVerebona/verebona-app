/**
 * Contrôles « À traiter » du registre — lot 83E (CDC cohérence §4.6, complément
 * PO du 23/10 ; arbitrages C-Q1, C-Q2, C-Q9, C-Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE DE PERTINENCE DU LOT 76 DEVIENT DEUX CONTRÔLES (même code métier)
 *
 * La campagne `l76-pertinence` (phases CARTES / DÉCISIONS / REPRISE, moteur
 * `runRelevanceCampaign`, RETIRÉ au lot 83E) réévaluait rétroactivement, avec
 * la décision de la PRODUCTION COURANTE, les cartes et décisions d'une
 * version antérieure du moteur. Le registre en reprend la fonction, sans
 * second moteur :
 *
 *   COH-TODO-STALE-DECISIONS   (phase DÉCISIONS) document dont la DERNIÈRE
 *     décision d'une règle « donnée » du pont, sans carte active, est périmée
 *     — moteur antérieur (dont le « contrat terminé » de l'ancienne
 *     détection), report échu, révision de connaissance changée (dépendances
 *     du même contrat comprises) : même sélection que la campagne, sans la
 *     reprise inconditionnelle des « contrat terminé » du moteur courant (un
 *     contrôle récurrent la rejouerait sans fin ; même règle que la sélection
 *     du balayage, `documentsToReevaluate`). Réparation : la décision
 *     centrale `syncDocumentRulesFromState` (création permise, déclencheur
 *     BACKFILL) — jamais T1, jamais d'écrasement d'une valeur de l'utilisateur.
 *   COH-TODO-RELEVANCE-CARDS   (phase CARTES) carte ouverte des familles que la
 *     campagne parcourait (pont documentaire hors règles « donnée » — déjà
 *     couvertes par COH-TODO-DOCUMENT-FIELDS —, intervention réelle, agenda
 *     sans date, équipement d'un bien supprimé, fournisseur à confirmer) dont
 *     la cible n'a jamais été jugée par la version COURANTE de son moteur
 *     (pont : `DOCUMENT_RULE_ENGINE_VERSION` ; familles « état » :
 *     `ADMISSIBILITY_VERSION`). Réparation : le producteur de la famille,
 *     restreint à la cible (mêmes producteurs que le balayage et que la
 *     campagne) ; la décision est tracée, la carte maintenue, fermée ou mise à
 *     jour par la décision, jamais par ce contrôle.
 *
 * Une même anomalie n'est corrigée que par UNE chaîne (C-Q9) : la campagne
 * n'existe plus ; une carte dont la cible a disparu relève du seul contrôle
 * COH-TODO-ORPHAN-CARDS ; une carte « donnée » documentaire, du seul
 * COH-TODO-DOCUMENT-FIELDS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUTRES CONTRÔLES « À TRAITER » DU LOT 83E
 *
 *   COH-TODO-ORPHAN-CARDS  carte ouverte dont l'objet a été supprimé (document
 *     supprimé ou regroupé, bien supprimé, échéance, équipement ou pièce
 *     disparus) : fermée TARGET_DELETED, tracée, par le service des cartes
 *     `closeActionsForDeletedTargets`. Cible fournisseur disparue : constat.
 *   COH-TODO-RESOLUTION-PROPAGATION  résolution non propagée : rattachement
 *     d'un document à un équipement choisi par l'utilisateur sur une carte
 *     LINK-ELT, appliqué à la fiche mais sans AUCUN lien documentaire actif
 *     vers l'équipement choisi (lien posé APRÈS la transaction, `afterCommit`,
 *     ou par le déclencheur de colonne) — reposé par le service des liens
 *     documentaires (`linkDocumentToAsset`, origine USER, même appel que la
 *     résolution). Un retrait ultérieur par l'utilisateur est respecté.
 *     Lot 85B (version 2) : résolutions « même réalité » (OPERATION-MATCH,
 *     consolidation du document) et déplacement d'un document vers un autre
 *     bien (LINK-ASSET-CONFLICT, liens documentaires) ajoutées.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { heldCardSql } from '@/services/to-process/publishability';

// ── Règles (catalogue de la production) ─────────────────────────────────────

/** Familles « état de la base » que la campagne parcourait (lot 72, C6). */
export const STATE_FAMILY_RULES = ['DATA-AGENDA-DATE', 'LINK-EQUIP-ASSET', 'SUPPLIER-IDENTITY'] as const;
const FAMILY_OF_STATE_RULE: Record<string, string> = { 'DATA-AGENDA-DATE': 'AGENDA_ITEM', 'LINK-EQUIP-ASSET': 'EQUIPMENT', 'SUPPLIER-IDENTITY': 'SUPPLIER' };

/** Règles « donnée » du pont documentaire (cartes couvertes par COH-TODO-DOCUMENT-FIELDS). */
export async function documentFieldRuleCodes(): Promise<string[]> {
  const { documentBridgeRules } = await import('@/services/to-process/rules-catalog');
  return documentBridgeRules().filter((r) => !!r.fieldKey).map((r) => r.code);
}

/** Règles des cartes réévaluées par COH-TODO-RELEVANCE-CARDS (pont hors « donnée », intervention, familles « état »). */
export async function relevanceCardRuleCodes(): Promise<string[]> {
  const { documentBridgeRules } = await import('@/services/to-process/rules-catalog');
  const { INTERVENTION_RULE_CODE } = await import('@/services/to-process/document-intervention');
  return [...documentBridgeRules().filter((r) => !r.fieldKey).map((r) => r.code), INTERVENTION_RULE_CODE, ...STATE_FAMILY_RULES];
}

/** Cible vivante d'une carte (SQL, alias `a` = to_process_actions). Fournisseur : toujours présumé vivant (constat seulement). */
const CIBLE_VIVANTE_SQL = `CASE a.target_type
    WHEN 'DOCUMENT' THEN EXISTS (SELECT 1 FROM asset_files f WHERE f.id = a.target_id AND f.account_id = a.account_id
                                   AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL)
    WHEN 'ASSET' THEN EXISTS (SELECT 1 FROM assets s WHERE s.id = a.target_id AND s.account_id = a.account_id AND s.deleted_at IS NULL)
    WHEN 'AGENDA_ITEM' THEN EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = a.target_id AND i.account_id = a.account_id)
    WHEN 'EQUIPMENT' THEN EXISTS (SELECT 1 FROM equipments e WHERE e.id = a.target_id)
    WHEN 'ROOM' THEN EXISTS (SELECT 1 FROM rooms r WHERE r.id = a.target_id AND r.account_id = a.account_id)
    ELSE true END`;

// ══ COH-TODO-STALE-DECISIONS ════════════════════════════════════════════════

/**
 * Décisions périmées des documents `ids` (lecture seule) — même sélection que
 * l'ancienne phase DÉCISIONS : dernière décision par règle « donnée », issue
 * sans carte (NO_ACTION, DEFER, AUTO_RESOLVED), aucune carte active de la
 * règle, et décision d'un moteur antérieur, « contrat terminé », report échu
 * ou connaissance changée.
 */
async function decisionsPerimees(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, Row[]>> {
  const out = new Map<number, Row[]>();
  if (!ids.length) return out;
  const ev = await import('@/services/to-process/document-field-evidence');
  if (!(await ev.ruleEvaluationsReady()) || !(await ev.relevanceColumnsReady())) return out;
  const rev = await ev.knowledgeRevSql('f');
  const r = await rows(ctx.sql, `
    SELECT e.file_id, e.rule_code, e.outcome, e.engine_version, e.knowledge_rev, e.pertinence, e.reevaluate_at, ${rev} AS current_rev
      FROM (SELECT DISTINCT ON (x.file_id, x.rule_code) x.file_id, x.rule_code, x.outcome, x.engine_version, x.knowledge_rev, x.pertinence, x.reevaluate_at
              FROM document_rule_evaluations x
             WHERE x.account_id = $1 AND x.file_id = ANY($2::int[]) AND x.rule_code = ANY($3::text[])
             ORDER BY x.file_id, x.rule_code, x.id DESC) e
      JOIN asset_files f ON f.id = e.file_id AND f.account_id = $1 AND f.deleted_at IS NULL
     WHERE e.outcome IN ('NO_ACTION', 'DEFER', 'AUTO_RESOLVED')
       AND NOT EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT'
                         AND a.target_id = e.file_id AND a.resolved_at IS NULL AND a.rule_code = e.rule_code)
       -- « Contrat terminé » de l'ANCIENNE détection : couvert par la version du moteur (une décision « terminé »
       -- du moteur courant n'est pas périmée — sinon le contrôle récurrent la rejouerait sans fin).
       AND (e.engine_version IS DISTINCT FROM $4
            OR (e.outcome = 'DEFER' AND e.reevaluate_at IS NOT NULL AND e.reevaluate_at <= $5::timestamptz)
            OR (e.knowledge_rev IS NOT NULL AND e.knowledge_rev IS DISTINCT FROM ${rev}))
     ORDER BY e.file_id, e.rule_code`,
  [accountId, intArray(ids), await documentFieldRuleCodes(), ev.DOCUMENT_RULE_ENGINE_VERSION, ctx.now]);
  for (const x of r) {
    const id = Number(x.file_id);
    out.set(id, [...(out.get(id) ?? []), x]);
  }
  return out;
}

const motifPeremption = (x: Row, version: string, now: Date): string => {
  if (x.engine_version !== version) return x.pertinence === 'CONTRACT_TERMINATED' ? 'OLD_CONTRACT_TERMINATED' : 'ENGINE_VERSION';
  if (x.outcome === 'DEFER' && x.reevaluate_at && new Date(x.reevaluate_at as string).getTime() <= now.getTime()) return 'DEFER_DUE';
  return 'KNOWLEDGE_CHANGED';
};

export const toProcessStaleDecisionsCheck: CoherenceCheck = {
  id: 'COH-TODO-STALE-DECISIONS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : décisions sans carte périmées (moteur, connaissance, report échu)',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'document',
  scope: 'documents vivants du compte portant une décision d’une règle « donnée » du pont documentaire',
  sources: ['document_rule_evaluations', 'to_process_actions', 'document_facts', 'document_field_values', 'document_source_units'],
  applicability: 'compte éligible ; journal des décisions (0418, 0444) présent',
  invariant: 'la dernière décision sans carte d’une règle a été prise par le moteur courant, sur la connaissance courante, et son report n’est pas échu',
  anomalies: ['STALE_DECISION'],
  autoRepairWhen: 'toujours (réévaluation par la décision centrale de la production, sans T1 ; IA T4 seulement dans les conditions de la production)',
  forbiddenRepairs: ['écrire une décision ou une valeur directement', 'relancer T1', 'écraser une valeur de l’utilisateur', 'supprimer une décision historique'],
  services: ['to-process/document-rule-bridge#syncDocumentRulesFromState'],
  chain: ['T1', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement du document',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-03', 'L83E-U-RELEVANCE'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT y.file_id AS id FROM document_rule_evaluations y
        JOIN asset_files f ON f.id = y.file_id AND f.account_id = y.account_id AND f.deleted_at IS NULL
       WHERE y.account_id = $1 AND y.file_id > $2 AND y.rule_code = ANY($3::text[])
       ORDER BY y.file_id LIMIT $4`, [accountId, afterId, await documentFieldRuleCodes(), limit]).catch((e: Error) => {
      // Table des décisions absente (fenêtre de déploiement) : rien à contrôler, jamais « conforme » par erreur.
      if (/document_rule_evaluations/.test(e.message) && /does not exist/.test(e.message)) return [];
      throw e;
    }));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2 AND f.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM document_rule_evaluations y WHERE y.account_id = f.account_id AND y.file_id = f.id AND y.rule_code = ANY($3::text[]))`,
    [accountId, e.entityId, await documentFieldRuleCodes()]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { DOCUMENT_RULE_ENGINE_VERSION } = await import('@/services/to-process/document-field-evidence');
    const vivants = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`, [accountId, intArray(ids)])));
    const perimees = await decisionsPerimees(ctx, accountId, ids);
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const p = perimees.get(id) ?? [];
      if (!p.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      const regles = p.map((x) => ({ rule: String(x.rule_code), outcome: x.outcome, why: motifPeremption(x, DOCUMENT_RULE_ENGINE_VERSION, ctx.now) }));
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'STALE_DECISION', faultyLink: 'TO_PROCESS',
        expected: `décision du moteur ${DOCUMENT_RULE_ENGINE_VERSION} sur la connaissance courante`, observed: regles,
        detail: { fileId: id, rules: regles },
        inputHash: hashOf({ id, p: p.map((x) => [x.rule_code, x.outcome, x.engine_version, x.knowledge_rev, x.current_rev, x.pertinence, x.reevaluate_at]) }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
    for (const { id, inspection } of items) {
      const regles = new Set(((inspection.detail as { rules?: Array<{ rule: string }> } | undefined)?.rules ?? []).map((x) => x.rule));
      const r = await syncDocumentRulesFromState(accountId, id, { reason: 'OBSOLETE', create: true, trigger: 'BACKFILL', runRef: ctx.correlationId });
      out.set(id, {
        called: true, service: 'syncDocumentRulesFromState', aiCalls: 0,
        result: { outcomes: Object.fromEntries([...regles].map((x) => [x, r.outcomes[x] ?? null])), created: r.created, closed: r.closed, written: r.written },
        rollbackRef: `document_rule_evaluations:file_id=${id};to_process_action_events:target=DOCUMENT:${id}`,
      });
      const err = r.errorDetails.filter((e) => e.kind !== 'TRACE_FAILED' && (e.ruleCode === '*' || regles.has(e.ruleCode)));
      if (err.length) throw new Error(`réévaluation du document ${id} en erreur : ${err.map((e) => `${e.ruleCode} · ${e.step} — ${e.cause}`).join(' ; ').slice(0, 300)}`);
    }
    return out;
  },
};

// ══ COH-TODO-RELEVANCE-CARDS ════════════════════════════════════════════════

export const toProcessRelevanceCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-RELEVANCE-CARDS',
  // Lot 98B (P0-C) : version 2 — une carte documentaire dont la dernière décision de SA règle est un maintien
  // technique (évaluation en erreur…) n'est plus CONSISTENT du seul fait d'une décision de la version courante.
  version: 2,
  status: 'ACTIVE',
  title: '« À traiter » : cartes jamais jugées par la version courante de leur moteur',
  domain: 'a-traiter',
  level: 'N2',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes du pont documentaire (hors règles « donnée »), d’intervention réelle, d’agenda sans date, d’équipement d’un bien supprimé, de fournisseur à confirmer',
  sources: ['to_process_actions', 'document_rule_evaluations', 'to_process_decisions'],
  applicability: 'compte éligible ; cible vivante (sinon : COH-TODO-ORPHAN-CARDS)',
  invariant: 'une carte ouverte est justifiée par une décision de la version courante du moteur de sa famille',
  anomalies: ['CARD_NOT_REEVALUATED', 'DECISION_NOT_DEMONSTRATED'],
  autoRepairWhen: 'toujours (producteur de la famille restreint à la cible : même décision que le balayage horaire)',
  forbiddenRepairs: ['fermer une carte sans décision du moteur', 'relancer T1', 'écraser une valeur de l’utilisateur', 'supprimer une carte'],
  services: [
    'to-process/document-rule-bridge#syncDocumentRulesFromState',
    'to-process/producers.service#produceAgendaActions', 'to-process/producers.service#produceEquipmentActions', 'to-process/producers.service#produceSupplierActions',
  ],
  chain: ['PERSISTENCE', 'TO_PROCESS'],
  triggers: ['DOCUMENT_UPDATED', 'AGENDA_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé',
  criticality: 'LOW',
  tests: ['L83E-E2E-03', 'L83E-U-RELEVANCE'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.rule_code = ANY($2::text[]) AND a.id > $3
       ORDER BY a.id LIMIT $4`, [accountId, await relevanceCardRuleCodes(), afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const type = e.type === 'AGENDA_ITEM_UPDATED' ? 'AGENDA_ITEM' : 'DOCUMENT';
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.target_type = $2 AND a.target_id = $3 AND a.rule_code = ANY($4::text[])
       ORDER BY a.id`, [accountId, type, e.entityId, await relevanceCardRuleCodes()]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ DOCUMENT_RULE_ENGINE_VERSION }, { ADMISSIBILITY_VERSION }] = await Promise.all([
      import('@/services/to-process/document-field-evidence'), import('@/services/to-process/admissibility'),
    ]);
    const r = await rows(ctx.sql, `
      SELECT a.id, a.target_type, a.target_id, a.rule_code, a.resolved_at IS NULL AS open, ${CIBLE_VIVANTE_SQL} AS alive,
             CASE WHEN a.target_type = 'DOCUMENT'
                  THEN EXISTS (SELECT 1 FROM document_rule_evaluations e WHERE e.account_id = a.account_id AND e.file_id = a.target_id AND e.engine_version = $3)
                  ELSE EXISTS (SELECT 1 FROM to_process_decisions d WHERE d.account_id = a.account_id AND d.target_type = a.target_type
                                 AND d.target_id = a.target_id AND d.rule_code = a.rule_code AND d.engine_version = $4) END AS current,
             ${heldCardSql('a')} AS held
        FROM to_process_actions a WHERE a.account_id = $1 AND a.id = ANY($2::int[])`,
    [accountId, intArray(ids), DOCUMENT_RULE_ENGINE_VERSION, ADMISSIBILITY_VERSION]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = { targetType: x.target_type, targetId: Number(x.target_id), rule: x.rule_code };
      // Cible disparue : relève de COH-TODO-ORPHAN-CARDS (une seule chaîne).
      if (x.alive !== true) { out.set(id, { verdict: 'CONSISTENT', detail: { ...detail, delegatedTo: 'COH-TODO-ORPHAN-CARDS' } }); continue; }
      if (x.current === true && x.held === true) {
        // Lot 98B (P0-C) : décision à jour mais maintien TECHNIQUE — jamais une carte justifiée ; nouvelle tentative quotidienne.
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'DECISION_NOT_DEMONSTRATED', faultyLink: 'TO_PROCESS',
          expected: 'décision démontrant l’utilité de la carte', observed: 'maintien technique', detail: { ...detail, standing: 'NOT_DEMONSTRATED' },
          inputHash: hashOf({ id, held: true, rule: x.rule_code, target: [x.target_type, x.target_id], jour: ctx.today }),
        });
        continue;
      }
      if (x.current === true) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      const version = x.target_type === 'DOCUMENT' ? DOCUMENT_RULE_ENGINE_VERSION : ADMISSIBILITY_VERSION;
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'CARD_NOT_REEVALUATED', faultyLink: 'TO_PROCESS',
        expected: `décision du moteur ${version}`, observed: 'aucune décision de la version courante', detail,
        inputHash: hashOf({ id, version, rule: x.rule_code, target: [x.target_type, x.target_id] }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const r = await rows(ctx.sql, `SELECT id, target_type, target_id, rule_code FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(items.map((x) => x.id))]);
    const bridge = await import('@/services/to-process/document-rule-bridge');
    const producteurs = await import('@/services/to-process/producers.service');
    for (const x of r) {
      const id = Number(x.id);
      const targetId = Number(x.target_id);
      const rollbackRef = `to_process_action_events:action_id=${id};to_process_decisions:target=${x.target_type}:${targetId}`;
      if (x.target_type === 'DOCUMENT') {
        const rep = await bridge.syncDocumentRulesFromState(accountId, targetId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef: ctx.correlationId });
        out.set(id, { called: true, service: 'syncDocumentRulesFromState', aiCalls: 0, result: { closed: rep.closed, updated: rep.updated, outcome: rep.outcomes[String(x.rule_code)] ?? null }, rollbackRef });
        const err = rep.errorDetails.filter((e) => e.kind !== 'TRACE_FAILED');
        if (err.length) throw new Error(`réévaluation du document ${targetId} en erreur : ${err.map((e) => `${e.ruleCode} · ${e.step} — ${e.cause}`).join(' ; ').slice(0, 300)}`);
        continue;
      }
      const famille = FAMILY_OF_STATE_RULE[String(x.rule_code)] ?? String(x.target_type);
      const opts = { trigger: 'BACKFILL' as const, runRef: ctx.correlationId, only: [targetId] };
      const rep = famille === 'AGENDA_ITEM' ? await producteurs.produceAgendaActions(accountId, opts)
        : famille === 'EQUIPMENT' ? await producteurs.produceEquipmentActions(accountId, opts)
          : await producteurs.produceSupplierActions(accountId, opts);
      const service = famille === 'AGENDA_ITEM' ? 'produceAgendaActions' : famille === 'EQUIPMENT' ? 'produceEquipmentActions' : 'produceSupplierActions';
      out.set(id, { called: true, service, aiCalls: 0, result: { created: rep.created, updated: rep.updated, closed: rep.closed }, rollbackRef });
      const err = (rep.errorDetails ?? []).filter((e) => e.kind !== 'TRACE_FAILED' && (e.targetId === undefined || e.targetId === targetId));
      if (err.length) throw new Error(`réévaluation ${famille} ${targetId} en erreur : ${err.map((e) => `${e.step} — ${e.cause}`).join(' ; ').slice(0, 300)}`);
    }
    return out;
  },
};

// ══ COH-TODO-ORPHAN-CARDS ═══════════════════════════════════════════════════

export const toProcessOrphanCardsCheck: CoherenceCheck = {
  id: 'COH-TODO-ORPHAN-CARDS',
  version: 1,
  status: 'ACTIVE',
  title: '« À traiter » : cartes ouvertes liées à un objet supprimé',
  domain: 'a-traiter',
  level: 'N1',
  objectType: 'to_process_action',
  scope: 'cartes ouvertes du compte, toutes familles, hors cartes « donnée » documentaires (COH-TODO-DOCUMENT-FIELDS)',
  sources: ['to_process_actions', 'asset_files', 'assets', 'agenda_items', 'equipments', 'rooms'],
  applicability: 'compte éligible',
  invariant: 'une carte ouverte porte sur un objet qui existe encore (document non supprimé ni regroupé, bien non supprimé, échéance, équipement, pièce)',
  anomalies: ['CARD_TARGET_DELETED', 'CARD_SUPPLIER_TARGET_UNVERIFIABLE'],
  autoRepairWhen: 'cible disparue (document, bien, échéance, équipement, pièce) : fermeture TARGET_DELETED tracée par le service des cartes',
  forbiddenRepairs: ['supprimer une carte', 'fermer une carte dont la cible existe', 'fermer sans événement d’audit'],
  services: ['to-process/producers.service#closeActionsForDeletedTargets'],
  chain: ['PERSISTENCE', 'TO_PROCESS'],
  triggers: ['DOCUMENT_DELETED', 'ASSET_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à la suppression',
  criticality: 'LOW',
  tests: ['L83E-E2E-04'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.id > $2
         AND NOT (a.target_type = 'DOCUMENT' AND a.rule_code = ANY($3::text[]))
       ORDER BY a.id LIMIT $4`, [accountId, afterId, await documentFieldRuleCodes(), limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const type = e.type === 'ASSET_DELETED' ? 'ASSET' : 'DOCUMENT';
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.resolved_at IS NULL AND a.target_type = $2 AND a.target_id = $3
         AND NOT (a.target_type = 'DOCUMENT' AND a.rule_code = ANY($4::text[]))
       ORDER BY a.id`, [accountId, type, e.entityId, await documentFieldRuleCodes()]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT a.id, a.target_type, a.target_id, a.rule_code, a.resolved_at IS NULL AS open, ${CIBLE_VIVANTE_SQL} AS alive,
             (a.target_type = 'SUPPLIER') AS supplier
        FROM to_process_actions a WHERE a.account_id = $1 AND a.id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x || x.open !== true) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = { targetType: x.target_type, targetId: Number(x.target_id), rule: x.rule_code };
      if (x.alive === true) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'CARD_TARGET_DELETED', faultyLink: 'TO_PROCESS',
        expected: 'carte fermée (cible supprimée)', observed: 'carte ouverte', detail, inputHash: hashOf({ id, target: [x.target_type, x.target_id] }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { closeActionsForDeletedTargets } = await import('@/services/to-process/producers.service');
    // Service des cartes : ferme (TARGET_DELETED, événement d'audit, transaction) TOUTES les cartes orphelines du compte — idempotent.
    const fermees = await closeActionsForDeletedTargets(accountId);
    for (const { id } of items) {
      out.set(id, { called: true, service: 'closeActionsForDeletedTargets', aiCalls: 0, result: { closedInAccount: fermees }, rollbackRef: `to_process_action_events:action_id=${id}` });
    }
    return out;
  },
};

// ══ COH-TODO-RESOLUTION-PROPAGATION ═════════════════════════════════════════
//
// Lot 85B (version 2) : résolutions dont l'effet est appliqué APRÈS la
// transaction de la carte (`afterCommit`), donc perdu si ce second temps
// échoue — en plus du rattachement document → équipement (LINK-ELT, 83E) :
//   · OPERATION-MATCH  « même réalité » / « autre réalité » : la décision
//     durable est écrite avec la carte, puis la consolidation du document
//     l'applique (`afterDecision` → `consolidateDocument`). Non propagée : le
//     candidat n'est pas rattaché à la réalité choisie (ou l'est encore à une
//     réalité écartée) alors que la décision est toujours active → même appel
//     (`consolidateDocument`), sans M3 ni T1 ;
//   · LINK-ASSET-CONFLICT « déplacer vers B » : la fiche (colonne) est écrite
//     avec la carte, puis les liens documentaires (`afterMove` : lien PRIMARY
//     vers B, retrait du lien vers A). Non propagée → mêmes appels du service
//     des liens, origine USER ; un lien retiré ou reposé par l'utilisateur
//     depuis la résolution est respecté.
// Les autres résolutions écrivent leur effet DANS la transaction de la carte
// (valeur et carte ensemble) ou ne déclenchent après coup que des chaînes déjà
// contrôlées ailleurs (projection Agenda des Opérations : COH-AGENDA-
// OPERATION-PROJECTION ; consolidation après un statut d'agenda : invariants
// O-1) — voir `coverage.ts`.

const LINK_ELT_RULE = 'LINK-ELT';
const OPERATION_MATCH_RULE = 'OPERATION-MATCH';
const ASSET_CONFLICT_RULE = 'LINK-ASSET-CONFLICT';
/** Règles dont la résolution est propagée après la transaction de la carte. */
export const PROPAGATED_RESOLUTION_RULES = [LINK_ELT_RULE, OPERATION_MATCH_RULE, ASSET_CONFLICT_RULE] as const;

/** Résolutions LINK-ELT (lecture) : équipement choisi, état de la fiche et du lien documentaire. */
async function resolutionsLinkElt(ctx: CheckContext, accountId: number, ids: readonly number[]): Promise<Map<number, Row>> {
  const r = await rows(ctx.sql, `
    SELECT a.id, a.target_id AS file_id, a.resolved_at, a.resolution_reason,
           (SELECT ev.new_value #>> '{}' FROM to_process_action_events ev
             WHERE ev.action_id = a.id AND ev.event = 'RESOLVED_ARBITRATION' ORDER BY ev.id DESC LIMIT 1) AS chosen,
           f.equipment_id AS current_equipment, (f.id IS NOT NULL AND f.deleted_at IS NULL) AS file_alive
      FROM to_process_actions a
      LEFT JOIN asset_files f ON f.id = a.target_id AND f.account_id = a.account_id
     WHERE a.account_id = $1 AND a.id = ANY($2::int[]) AND a.rule_code = $3`, [accountId, intArray(ids), LINK_ELT_RULE]);
  const out = new Map<number, Row>();
  for (const x of r) {
    const chosen = /^\d+$/.test(String(x.chosen ?? '')) ? Number(x.chosen) : null;
    let link: Row | undefined;
    if (chosen !== null) {
      [link] = await rows(ctx.sql, `
        SELECT bool_or(status = 'ACTIVE') AS active_link,
               bool_or(status = 'REMOVED' AND removed_at >= $3::timestamptz) AS removed_after
          FROM document_asset_links WHERE file_id = $1 AND equipment_id = $2`, [Number(x.file_id), chosen, x.resolved_at]);
    }
    out.set(Number(x.id), { ...x, chosen, activeLink: link?.active_link === true, removedAfter: link?.removed_after === true });
  }
  return out;
}

/** Inspection LINK-ELT (83E, inchangée). */
function inspectLinkElt(x: Row | undefined): Inspection {
  if (!x || x.resolution_reason !== 'USER_ARBITRATED' || x.file_alive !== true) return { verdict: 'GONE' };
  const detail = { rule: LINK_ELT_RULE, fileId: Number(x.file_id), chosenEquipmentId: x.chosen };
  // Choix illisible, ou changé / retiré depuis par l'utilisateur : son geste fait foi.
  if (x.chosen === null || Number(x.current_equipment) !== x.chosen || x.removedAfter === true || x.activeLink === true) {
    return { verdict: 'CONSISTENT', detail };
  }
  return {
    verdict: 'REPAIRABLE', anomaly: 'RESOLUTION_NOT_PROPAGATED', faultyLink: 'LINK',
    expected: `lien documentaire actif vers l’équipement ${x.chosen}`, observed: 'lien absent', detail,
    inputHash: hashOf({ id: Number(x.id), chosen: x.chosen, file: x.file_id }),
  };
}

/**
 * Lot 85B — état d'une résolution OPERATION-MATCH (pure) : la décision durable
 * est-elle appliquée ? `SAME` : le candidat doit être une source active de la
 * réalité choisie (canonique) ; `DISTINCT` (ou réalités écartées) : il ne doit
 * plus être source active d'aucune réalité écartée.
 */
export function operationMatchPropagation(s: {
  fileAlive: boolean; candidateActive: boolean; candidatePending: boolean; decisionsActive: boolean;
  choice: 'SAME' | 'DISTINCT' | null; chosenCanonical: number | null; attachedTo: readonly number[]; rejectedCanonical: readonly number[];
}): 'GONE' | 'CONSISTENT' | 'NOT_ATTACHED' | 'STILL_ATTACHED_TO_REJECTED' {
  if (!s.fileAlive || !s.candidateActive || !s.choice) return 'GONE';
  // Décision annulée depuis, ou consolidation déjà demandée : rien à propager.
  if (!s.decisionsActive || s.candidatePending) return 'CONSISTENT';
  if (s.choice === 'SAME' && s.chosenCanonical !== null && !s.attachedTo.includes(s.chosenCanonical)) return 'NOT_ATTACHED';
  if (s.attachedTo.some((id) => s.rejectedCanonical.includes(id) && id !== s.chosenCanonical)) return 'STILL_ATTACHED_TO_REJECTED';
  return 'CONSISTENT';
}

/** Réalité canonique (fusions suivies) — lecture. */
const CANONICAL_SQL = (col: string) => `(WITH RECURSIVE ch(id, m, d) AS (
    SELECT o.id, o.merged_into_operation_id, 0 FROM business_operations o WHERE o.id = ${col}
    UNION ALL SELECT o.id, o.merged_into_operation_id, ch.d + 1 FROM business_operations o JOIN ch ON o.id = ch.m WHERE ch.d < 10)
  SELECT id FROM ch WHERE m IS NULL LIMIT 1)`;

async function inspectOperationMatch(ctx: CheckContext, accountId: number, id: number): Promise<Inspection> {
  const [x] = await rows(ctx.sql, `
    SELECT a.id, a.target_id AS file_id, a.resolution_reason, a.trigger_context->>'candidateKey' AS candidate_key,
           ev.new_value AS choice, ev.previous_value AS previous,
           EXISTS (SELECT 1 FROM asset_files f WHERE f.id = a.target_id AND f.account_id = a.account_id AND f.deleted_at IS NULL) AS file_alive
      FROM to_process_actions a
      LEFT JOIN LATERAL (SELECT e.new_value, e.previous_value FROM to_process_action_events e
                          WHERE e.action_id = a.id AND e.event = 'RESOLVED_ARBITRATION' ORDER BY e.id DESC LIMIT 1) ev ON true
     WHERE a.account_id = $1 AND a.id = $2 AND a.rule_code = $3`, [accountId, id, OPERATION_MATCH_RULE]);
  if (!x || x.resolution_reason !== 'USER_ARBITRATED') return { verdict: 'GONE' };
  const choice = (typeof x.choice === 'string' ? JSON.parse(x.choice) : x.choice) as { kind?: string; operationId?: number } | null;
  const previous = (typeof x.previous === 'string' ? JSON.parse(x.previous) : x.previous) as { decisionIds?: number[] } | null;
  const fileId = Number(x.file_id);
  const key = String(x.candidate_key ?? '');
  const [cand] = await rows(ctx.sql, `
    SELECT bool_or(status = 'ACTIVE') AS active, bool_or(status = 'ACTIVE' AND t3_pending) AS pending FROM document_operation_candidates
     WHERE account_id = $1 AND file_id = $2 AND candidate_key = $3`, [accountId, fileId, key]);
  const decisions = await rows(ctx.sql, `
    SELECT d.decision, d.active, ${CANONICAL_SQL('d.candidate_operation_id')} AS canonical
      FROM business_operation_match_decisions d WHERE d.account_id = $1 AND d.id = ANY($2::bigint[])`,
  [accountId, intArray((previous?.decisionIds ?? []).map(Number))]);
  const attached = idsOf(await rows(ctx.sql, `
    SELECT DISTINCT s.operation_id AS id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
     WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text AND s.locator->>'candidateKey' = $3
       AND o.merged_into_operation_id IS NULL AND o.invalidated_at IS NULL ORDER BY 1`, [accountId, fileId, key]));
  const kind = choice?.kind === 'SAME' || choice?.kind === 'DISTINCT' ? choice.kind : null;
  const chosenCanonical = decisions.find((d) => d.decision === 'CONFIRMED' && d.active === true)?.canonical;
  const etat = operationMatchPropagation({
    fileAlive: x.file_alive === true, candidateActive: cand?.active === true, candidatePending: cand?.pending === true,
    decisionsActive: decisions.some((d) => d.active === true), choice: kind,
    chosenCanonical: chosenCanonical == null ? null : Number(chosenCanonical), attachedTo: attached,
    rejectedCanonical: decisions.filter((d) => d.decision === 'REJECTED' && d.active === true && d.canonical != null).map((d) => Number(d.canonical)),
  });
  const detail = { rule: OPERATION_MATCH_RULE, fileId, candidateKey: key, choice: kind, chosenOperationId: chosenCanonical == null ? null : Number(chosenCanonical), attachedTo: attached };
  if (etat === 'GONE') return { verdict: 'GONE' };
  if (etat === 'CONSISTENT') return { verdict: 'CONSISTENT', detail };
  return {
    verdict: 'REPAIRABLE', anomaly: 'RESOLUTION_NOT_PROPAGATED', faultyLink: 'T3',
    expected: kind === 'SAME' ? `document rattaché à la réalité choisie (${detail.chosenOperationId})` : 'document détaché des réalités écartées',
    observed: { attachedTo: attached, state: etat }, detail,
    inputHash: hashOf({ id, etat, attached, chosen: detail.chosenOperationId }),
  };
}

async function inspectAssetConflictMove(ctx: CheckContext, accountId: number, id: number): Promise<Inspection> {
  const [x] = await rows(ctx.sql, `
    SELECT a.id, a.target_id AS file_id, a.resolution_reason, a.resolved_at, (a.trigger_context->>'currentAssetId')::int AS from_asset,
           ev.new_value->>'choice' AS choice, (ev.new_value->>'assetId')::int AS to_asset,
           f.asset_id AS current_asset, (f.id IS NOT NULL AND f.deleted_at IS NULL) AS file_alive,
           EXISTS (SELECT 1 FROM assets b WHERE b.id = (ev.new_value->>'assetId')::int AND b.account_id = a.account_id AND b.deleted_at IS NULL) AS to_alive
      FROM to_process_actions a
      LEFT JOIN asset_files f ON f.id = a.target_id AND f.account_id = a.account_id
      LEFT JOIN LATERAL (SELECT e.new_value FROM to_process_action_events e
                          WHERE e.action_id = a.id AND e.event = 'RESOLVED_ARBITRATION' ORDER BY e.id DESC LIMIT 1) ev ON true
     WHERE a.account_id = $1 AND a.id = $2 AND a.rule_code = $3`, [accountId, id, ASSET_CONFLICT_RULE]);
  if (!x || x.resolution_reason !== 'USER_ARBITRATED' || x.choice !== 'MOVE' || x.file_alive !== true || x.to_asset == null) return { verdict: 'GONE' };
  const fileId = Number(x.file_id);
  const to = Number(x.to_asset);
  const from = x.from_asset == null ? null : Number(x.from_asset);
  const detail = { rule: ASSET_CONFLICT_RULE, fileId, fromAssetId: from, toAssetId: to };
  // Le déplacement n'est plus en vigueur sur la fiche (geste ultérieur de l'utilisateur), ou B supprimé : rien à propager.
  if (Number(x.current_asset) !== to || x.to_alive !== true) return { verdict: 'CONSISTENT', detail };
  const [l] = await rows(ctx.sql, `
    SELECT bool_or(asset_id = $2 AND status = 'ACTIVE') AS to_active,
           bool_or(asset_id = $2 AND status = 'REMOVED' AND removed_at >= $4::timestamptz) AS to_removed_after,
           bool_or(asset_id = $3 AND status = 'ACTIVE' AND origin IN ('USER', 'AI', 'MIGRATION') AND created_at < $4::timestamptz) AS from_stale,
           bool_or(asset_id = $3 AND status = 'ACTIVE' AND created_at >= $4::timestamptz) AS from_relinked
      FROM document_asset_links WHERE file_id = $1 AND equipment_id IS NULL AND substructure_id IS NULL`, [fileId, to, from ?? 0, x.resolved_at]);
  const linkMissing = l?.to_active !== true && l?.to_removed_after !== true;
  const staleFromLink = from !== null && l?.from_stale === true && l?.from_relinked !== true;
  if (!linkMissing && !staleFromLink) return { verdict: 'CONSISTENT', detail };
  return {
    verdict: 'REPAIRABLE', anomaly: 'RESOLUTION_NOT_PROPAGATED', faultyLink: 'LINK',
    expected: `lien PRIMARY vers le bien ${to}${from !== null ? `, plus de lien vers le bien ${from}` : ''}`,
    observed: { linkToMissing: linkMissing, linkFromStillActive: staleFromLink }, detail: { ...detail, linkMissing, staleFromLink },
    inputHash: hashOf({ id, to, from, linkMissing, staleFromLink }),
  };
}

export const toProcessResolutionPropagationCheck: CoherenceCheck = {
  id: 'COH-TODO-RESOLUTION-PROPAGATION',
  // Lot 85B : version 2 — résolutions « même réalité » et déplacement de document ajoutées (stock réexaminé, §6.4).
  version: 2,
  status: 'ACTIVE',
  title: '« À traiter » : résolution appliquée mais non propagée (équipement choisi, même réalité, déplacement de document)',
  domain: 'a-traiter',
  level: 'N1',
  objectType: 'to_process_action',
  scope: 'cartes résolues par l’utilisateur dont l’effet est appliqué après la transaction de la carte : LINK-ELT, OPERATION-MATCH, LINK-ASSET-CONFLICT (déplacement)',
  sources: ['to_process_actions', 'to_process_action_events', 'asset_files', 'document_asset_links', 'document_operation_candidates', 'business_operation_match_decisions', 'business_operation_sources'],
  applicability: 'compte éligible ; document vivant ; choix de l’utilisateur toujours en vigueur (fiche, décision durable active)',
  invariant: 'l’effet choisi sur la carte est présent partout où la résolution le propage : lien documentaire vers l’équipement choisi ; rattachement du document à la réalité choisie (aucun à une réalité écartée) ; lien PRIMARY vers le bien de destination, plus de lien vers l’ancien bien',
  anomalies: ['RESOLUTION_NOT_PROPAGATED'],
  autoRepairWhen: 'choix de l’utilisateur toujours en vigueur, effet absent et jamais défait depuis par l’utilisateur : même appel que la résolution',
  forbiddenRepairs: ['reposer un lien retiré par l’utilisateur', 'modifier la fiche', 'rouvrir la carte', 'écrire une décision de rapprochement', 'appeler l’IA (M3)'],
  services: [
    'documents/document-asset-links#linkDocumentToAsset', 'documents/document-asset-links#unlinkDocument',
    'business-operations/consolidation/consolidator#consolidateDocument',
  ],
  chain: ['TO_PROCESS', 'T3', 'LINK'],
  triggers: ['DOCUMENT_UPDATED', 'TO_PROCESS_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-05', 'L85B-E2E-03', 'L85B-U-FAMILIES'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.rule_code = ANY($2::text[]) AND a.resolution_reason = 'USER_ARBITRATED' AND a.id > $3
       ORDER BY a.id LIMIT $4`, [accountId, [...PROPAGATED_RESOLUTION_RULES], afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.type === 'TO_PROCESS_ITEM_UPDATED') {
      // Résolution d'une carte (identifiant public non numérique) : résolutions propagées des dernières 24 h.
      return idsOf(await rows(ctx.sql, `
        SELECT a.id FROM to_process_actions a
         WHERE a.account_id = $1 AND a.rule_code = ANY($2::text[]) AND a.resolution_reason = 'USER_ARBITRATED' AND a.resolved_at >= $3::timestamptz
         ORDER BY a.id`, [accountId, [...PROPAGATED_RESOLUTION_RULES], new Date(ctx.now.getTime() - 86_400_000)]));
    }
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT a.id FROM to_process_actions a
       WHERE a.account_id = $1 AND a.rule_code = ANY($2::text[]) AND a.resolution_reason = 'USER_ARBITRATED' AND a.target_type = 'DOCUMENT' AND a.target_id = $3
       ORDER BY a.id`, [accountId, [...PROPAGATED_RESOLUTION_RULES], e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const regles = new Map((await rows(ctx.sql, `SELECT id, rule_code FROM to_process_actions WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(ids)])).map((x) => [Number(x.id), String(x.rule_code)]));
    const linkElt = await resolutionsLinkElt(ctx, accountId, ids.filter((id) => regles.get(id) === LINK_ELT_RULE));
    for (const id of ids) {
      const regle = regles.get(id);
      if (regle === LINK_ELT_RULE) out.set(id, inspectLinkElt(linkElt.get(id)));
      else if (regle === OPERATION_MATCH_RULE) out.set(id, await inspectOperationMatch(ctx, accountId, id));
      else if (regle === ASSET_CONFLICT_RULE) out.set(id, await inspectAssetConflictMove(ctx, accountId, id));
      else out.set(id, { verdict: 'GONE' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const liens = await import('@/services/documents/document-asset-links/document-asset-links.service');
    for (const { id, inspection } of items) {
      const d = inspection.detail as { rule?: string; fileId: number; chosenEquipmentId?: number; fromAssetId?: number | null; toAssetId?: number; linkMissing?: boolean; staleFromLink?: boolean };
      if (d.rule === OPERATION_MATCH_RULE) {
        // Même appel que la propagation de la résolution (`afterDecision`).
        const { consolidateDocument } = await import('@/services/business-operations/consolidation/consolidator');
        const r = await consolidateDocument(accountId, d.fileId, { today: ctx.today, correlationId: ctx.correlationId });
        if (r.error) throw new Error(`consolidation du document ${d.fileId} en erreur : ${r.error}`);
        out.set(id, { called: true, service: 'consolidateDocument', aiCalls: 0, result: { outcomes: r.outcomes, changes: r.changes, operations: r.operations.slice(0, 20) },
          rollbackRef: `business_operation_history:correlation=${ctx.correlationId}` });
        continue;
      }
      if (d.rule === ASSET_CONFLICT_RULE) {
        // Mêmes appels que `afterMove` (service des liens, origine USER).
        let removed = 0;
        if (d.staleFromLink && d.fromAssetId) {
          removed = await liens.unlinkDocument({ accountId, fileId: d.fileId, target: { assetId: d.fromAssetId }, origins: ['USER', 'AI', 'MIGRATION'] });
        }
        const r = d.linkMissing ? await liens.linkDocumentToAsset({ accountId, fileId: d.fileId, target: { assetId: d.toAssetId! }, role: 'PRIMARY', origin: 'USER' }) : null;
        out.set(id, { called: true, service: 'linkDocumentToAsset', aiCalls: 0, result: { removed, outcome: r?.outcome ?? null, linkId: r?.link?.id ?? null },
          rollbackRef: r?.link?.id ? `document_asset_links:id=${r.link.id}` : `document_asset_links:file_id=${d.fileId}` });
        continue;
      }
      // LINK-ELT : même appel que la propagation de la résolution (`DOCUMENT_ELEMENT_WRITER.afterCommit`).
      const r = await liens.linkDocumentToAsset({ accountId, fileId: d.fileId, target: { equipmentId: d.chosenEquipmentId! }, role: 'SECONDARY', origin: 'USER' });
      out.set(id, { called: true, service: 'linkDocumentToAsset', aiCalls: 0, result: { outcome: r.outcome, linkId: r.link?.id ?? null }, rollbackRef: r.link?.id ? `document_asset_links:id=${r.link.id}` : null });
    }
    return out;
  },
};
