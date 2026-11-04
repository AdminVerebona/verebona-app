/**
 * Lot 109A — RAPPORT BO AVANT / APRÈS des relations métier (ticket P1
 * « Relations métier », §8, AC16) : section `tracabilite/relations-metier.json`
 * du diagnostic durable (lot 107G, même moteur, même instantané REPEATABLE
 * READ READ ONLY). Lecture seule, aucune IA, un compte à la fois (mémoire
 * bornée quel que soit le volume).
 *
 * Par compte :
 *   · documents examinés, Opérations actives (avec fournisseur, avec
 *     équipement) ;
 *   · relations DIRECTES (document ↔ fournisseur, document ↔ équipement,
 *     document ↔ Agenda) et relations HÉRITÉES par l'Opération (couples
 *     document × fournisseur / équipement visibles SEULEMENT via une
 *     Opération — jamais matérialisés) ;
 *   · liens Opération ↔ fournisseur par état, origine et rôle ;
 *   · reprise (contrôle de cohérence COH-OPERATION-RELATIONS, corrélation
 *     `coherence:…`) : liens créés, rétablis, écartés (par motif),
 *     transferts ; refus de l'utilisateur ;
 *   · avant / après : liens actifs AVANT la reprise (reconstitués depuis
 *     l'historique : actifs − créés/rétablis + écartés) et APRÈS (actuels) ;
 *   · anomalies résiduelles : inspection courante (relations démontrées non
 *     persistées, liens sans preuve, héritages, intercomptes, preuves
 *     refusées par l'utilisateur) et preuves du contrôle par résultat.
 */
import type { DiagPlanKit } from '@/services/admin/diagnostics-export/engine';
import type { GroupingRunner } from '@/services/business-operations/grouping/runner';
import { inspectOperationSuppliers, operationSuppliersReady } from './operation-suppliers';
import { RELATIONS_CONTRACT_VERSION } from './read-contract';

/** Opérations inspectées par lot (mémoire bornée). */
const INSPECTION_BATCH = 500;
const REPRISE_CORRELATION = 'coherence:%';

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export interface RelationsAudit {
  compte: number;
  contrat: string;
  documentsExamines: number;
  operations: { actives: number; avecFournisseur: number; avecEquipement: number };
  relationsDirectes: { documentFournisseur: number; documentEquipement: number; documentAgenda: number };
  relationsHeritees: { documentFournisseurViaOperation: number; documentEquipementViaOperation: number; agendaFournisseurViaOperation: number };
  liensOperationFournisseur: { parEtat: Record<string, number>; parOrigine: Record<string, number>; parRole: Record<string, number> };
  reprise: { crees: number; retablis: number; ecartes: Array<{ motif: string; n: number }>; transferts: number; refusUtilisateur: number };
  avantApres: { avant: { liensActifs: number }; apres: { liensActifs: number } };
  anomaliesResiduelles: { aPoser: number; aRetirer: number; aMettreAJour: number; heritagesApresFusion: number; intercomptes: number; preuvesRefuseesParUtilisateur: number };
  controle: Record<string, number>;
}

const groupe = (rows: Row[], k: string): Record<string, number> => Object.fromEntries(rows.map((r) => [String(r[k]), n(r.n)]));

/** Audit d'UN compte (lecture seule). */
export async function buildRelationsAudit(r: GroupingRunner, accountId: number): Promise<RelationsAudit> {
  const pret = await operationSuppliersReady(r);
  const [c] = await r.q<Row>(`
    SELECT (SELECT count(*) FROM asset_files f WHERE f.account_id = $1 AND f.deleted_at IS NULL) AS docs,
           (SELECT count(*) FROM business_operations o WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS ops,
           (SELECT count(DISTINCT l.operation_id) FROM business_operation_equipment_links l JOIN business_operations o ON o.id = l.operation_id
             AND o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL WHERE l.active) AS ops_eq,
           (SELECT count(*) FROM document_suppliers ds JOIN asset_files f ON f.id = ds.document_id AND f.account_id = $1 AND f.deleted_at IS NULL
             JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = $1) AS d_sup,
           (SELECT count(*) FROM (SELECT l.file_id, l.equipment_id FROM document_asset_links l JOIN asset_files f ON f.id = l.file_id AND f.deleted_at IS NULL
                                   WHERE l.account_id = $1 AND l.status = 'ACTIVE' AND l.equipment_id IS NOT NULL AND l.link_role IN ('PRIMARY', 'SECONDARY')
                                  UNION SELECT f.id, f.equipment_id FROM asset_files f WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.equipment_id IS NOT NULL) x) AS d_eq,
           (SELECT count(*) FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
             WHERE cardinality(l.provenances) = 0 OR l.provenances && ARRAY['MANUAL_DIRECT', 'AI_DIRECT']::text[]) AS d_ag,
           (SELECT count(*) FROM (
              SELECT DISTINCT d.file_id, el.equipment_id FROM business_operation_equipment_links el
                JOIN business_operations o ON o.id = el.operation_id AND o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
                JOIN business_operation_documents d ON d.operation_id = el.operation_id AND d.active
                JOIN asset_files f ON f.id = d.file_id AND f.deleted_at IS NULL
               WHERE el.active AND NOT EXISTS (SELECT 1 FROM document_asset_links x WHERE x.file_id = d.file_id AND x.equipment_id = el.equipment_id AND x.status = 'ACTIVE')
                 AND f.equipment_id IS DISTINCT FROM el.equipment_id) y) AS v_eq`, [accountId]);
  const audit: RelationsAudit = {
    compte: accountId, contrat: RELATIONS_CONTRACT_VERSION,
    documentsExamines: n(c?.docs),
    operations: { actives: n(c?.ops), avecFournisseur: 0, avecEquipement: n(c?.ops_eq) },
    relationsDirectes: { documentFournisseur: n(c?.d_sup), documentEquipement: n(c?.d_eq), documentAgenda: n(c?.d_ag) },
    relationsHeritees: { documentFournisseurViaOperation: 0, documentEquipementViaOperation: n(c?.v_eq), agendaFournisseurViaOperation: 0 },
    liensOperationFournisseur: { parEtat: {}, parOrigine: {}, parRole: {} },
    reprise: { crees: 0, retablis: 0, ecartes: [], transferts: 0, refusUtilisateur: 0 },
    avantApres: { avant: { liensActifs: 0 }, apres: { liensActifs: 0 } },
    anomaliesResiduelles: { aPoser: 0, aRetirer: 0, aMettreAJour: 0, heritagesApresFusion: 0, intercomptes: 0, preuvesRefuseesParUtilisateur: 0 },
    controle: {},
  };
  if (!pret) return audit;

  const ACTIF = `l.account_id = $1 AND l.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM business_operations o WHERE o.id = l.operation_id AND o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)`;
  const [v] = await r.q<Row>(`
    SELECT (SELECT count(DISTINCT l.operation_id) FROM business_operation_suppliers l WHERE ${ACTIF}) AS ops_sup,
           (SELECT count(*) FROM (SELECT DISTINCT d.file_id, l.supplier_id FROM business_operation_suppliers l
              JOIN business_operation_documents d ON d.operation_id = l.operation_id AND d.active
              JOIN asset_files f ON f.id = d.file_id AND f.deleted_at IS NULL
             WHERE ${ACTIF} AND NOT EXISTS (SELECT 1 FROM document_suppliers ds WHERE ds.document_id = d.file_id AND ds.supplier_id = l.supplier_id)) x) AS v_sup,
           (SELECT count(*) FROM (SELECT DISTINCT i.id, l.supplier_id FROM business_operation_suppliers l
              JOIN agenda_items i ON i.business_operation_id = l.operation_id AND i.account_id = $1
             WHERE ${ACTIF} AND NOT EXISTS (SELECT 1 FROM agenda_item_suppliers s WHERE s.agenda_item_id = i.id AND s.supplier_id = l.supplier_id)) y) AS v_ag`, [accountId]);
  audit.operations.avecFournisseur = n(v?.ops_sup);
  audit.relationsHeritees.documentFournisseurViaOperation = n(v?.v_sup);
  audit.relationsHeritees.agendaFournisseurViaOperation = n(v?.v_ag);

  audit.liensOperationFournisseur.parEtat = groupe(await r.q<Row>(`SELECT status AS k, count(*) AS n FROM business_operation_suppliers WHERE account_id = $1 GROUP BY 1 ORDER BY 1`, [accountId]), 'k');
  audit.liensOperationFournisseur.parOrigine = groupe(await r.q<Row>(`SELECT origin AS k, count(*) AS n FROM business_operation_suppliers l WHERE ${ACTIF} GROUP BY 1 ORDER BY 1`, [accountId]), 'k');
  audit.liensOperationFournisseur.parRole = groupe(await r.q<Row>(`SELECT role AS k, count(*) AS n FROM business_operation_suppliers l WHERE ${ACTIF} GROUP BY 1 ORDER BY 1`, [accountId]), 'k');

  const h = await r.q<Row>(`SELECT action, reason_code, count(*) AS n FROM business_operation_supplier_history
                             WHERE account_id = $1 AND correlation_id LIKE $2 GROUP BY 1, 2 ORDER BY 1, 2`, [accountId, REPRISE_CORRELATION]);
  const somme = (a: string) => h.filter((x) => x.action === a).reduce((t, x) => t + n(x.n), 0);
  audit.reprise.crees = somme('LINKED');
  audit.reprise.retablis = somme('RESTORED');
  audit.reprise.transferts = somme('TRANSFERRED');
  audit.reprise.ecartes = h.filter((x) => x.action === 'REMOVED').map((x) => ({ motif: String(x.reason_code), n: n(x.n) }));
  const [refus] = await r.q<Row>(`SELECT count(*) AS n FROM business_operation_suppliers WHERE account_id = $1 AND status = 'REJECTED'`, [accountId]);
  audit.reprise.refusUtilisateur = n(refus?.n);

  const apres = Object.values(audit.liensOperationFournisseur.parOrigine).reduce((t, x) => t + x, 0);
  const ecartes = audit.reprise.ecartes.reduce((t, x) => t + x.n, 0);
  audit.avantApres = { avant: { liensActifs: Math.max(0, apres - audit.reprise.crees - audit.reprise.retablis + ecartes) }, apres: { liensActifs: apres } };

  // Anomalies résiduelles : inspection courante, par lots (curseur sur l'identifiant, aucun plafond).
  for (let after = 0; ;) {
    const ids = (await r.q<{ id: number }>(`SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND o.id > $2
        AND ((o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL)
             OR EXISTS (SELECT 1 FROM business_operation_suppliers l WHERE l.operation_id = o.id AND l.status = 'ACTIVE'))
      ORDER BY o.id LIMIT ${INSPECTION_BATCH}`, [accountId, after])).map((x) => Number(x.id));
    if (!ids.length) break;
    after = ids[ids.length - 1];
    for (const x of (await inspectOperationSuppliers(r, accountId, ids)).values()) {
      const a = audit.anomaliesResiduelles;
      a.aPoser += x.plan.add.length + x.plan.restore.length;
      a.aRetirer += x.plan.remove.length;
      a.aMettreAJour += x.plan.update.length;
      a.heritagesApresFusion += x.inheritedOnMerged.length;
      a.intercomptes += x.crossAccount.length;
      a.preuvesRefuseesParUtilisateur += x.plan.suppressed.length;
    }
    if (ids.length < INSPECTION_BATCH) break;
  }
  try {
    audit.controle = groupe(await r.q<Row>(`SELECT COALESCE(last_result, 'EN_COURS') AS k, count(*) AS n FROM coherence_object_proofs
                                             WHERE account_id = $1 AND check_id = 'COH-OPERATION-RELATIONS' GROUP BY 1 ORDER BY 1`, [accountId]), 'k');
  } catch {
    audit.controle = {};
  }
  return audit;
}

/**
 * Fichier du diagnostic durable : un audit par compte du filtre (même
 * instantané). Une erreur sur un compte est consignée, les autres comptes
 * restent rendus (jamais un faux « complet » : `error` renseigné).
 */
export function planRelationsReport(kit: DiagPlanKit, accountIds: readonly number[]): void {
  kit.entry('tracabilite/relations-metier.json',
    'Relations métier (lot 109A) par compte : documents examinés, Opérations, relations directes / héritées par l’Opération, liens Opération ↔ fournisseur (état, origine, rôle), reprise (créés, rétablis, écartés par motif, transferts, refus), avant / après, anomalies résiduelles, preuves du contrôle COH-OPERATION-RELATIONS',
    async (w) => {
      await w('[');
      let i = 0;
      const errors: string[] = [];
      const runner: GroupingRunner = { q: async <T>(text: string, params: readonly unknown[] = []) => (await kit.s.savepoint(() => kit.s.q(text, params as unknown[]))) as unknown as T[] };
      for (const a of accountIds) {
        try {
          const audit = await buildRelationsAudit(runner, a);
          await w(`${i++ ? ',' : ''}\n  ${kit.safeJson(audit)}`);
        } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          errors.push(`compte #${a} : ${(e as Error)?.message ?? String(e)}`);
        }
      }
      await w(`${i ? '\n' : ''}]\n`);
      return { expected: accountIds.length, count: i, batches: 1, error: errors.length ? errors.join(' ; ').slice(0, 2000) : null };
    }, undefined, 'tracabilite');
}
