/**
 * AUDIT DU STOCK des opérations et de l'Agenda (lot 116C, seconde partie —
 * carte Trello #806 : migration et audit des données existantes ; CDC
 * « Opérations / Agenda V2.0 » §22, AC61 à AC66, AC73).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE C'EST
 *
 * Un audit RÉUTILISABLE, compte par compte, des données créées AVANT les règles
 * de la carte #806 (regrouper ≠ associer, assurance / sinistre et financement /
 * acquisition distincts, dates d'un même fait, abandon du rôle « principal »).
 * Il ne crée AUCUN second mécanisme :
 *   · les écarts du GRAPHE sont ceux du contrôle `COH-OPERATION-GRAPH`
 *     (`graph/store.ts › auditOperationGraph`), repris tels quels ;
 *   · la volumétrie vient de requêtes de comptage bornées au compte, dans
 *     l'esprit de l'inventaire `inventory.ts` (lot 113AP) ;
 *   · les mesures PROPRES AU STOCK (ci-dessous) ne font que LIRE.
 *
 * SIMULATION D'ABORD. Sans `apply`, tout est lu dans UNE transaction
 * `REPEATABLE READ READ ONLY` : PostgreSQL refuse toute écriture. Le rapport
 * dit, pour chaque anomalie, ce qu'il en serait fait :
 *   · `CERTAIN_FIX`  — cas CERTAIN, correction additive et sans perte ;
 *   · `ARBITRATION`  — demande une décision (de l'utilisateur ou du PO) : rien
 *     n'est corrigé, le cas est listé dans le rapport d'arbitrage ;
 *   · `REPORT`       — constat pour l'exploitation, aucune action.
 *
 * UNE SEULE CORRECTION AUTOMATIQUE, parce qu'elle est la seule CERTAINE :
 * un événement rattaché par la colonne historique `agenda_items.business_operation_id`
 * à une opération ACTIVE de son compte, sans AUCUNE ligne dans le graphe et sans
 * refus de l'utilisateur, reçoit le lien du graphe qui lui manque (même forme
 * que la reprise 1716 et que `resyncLegacyAgendaLinks`, moitié « pose »
 * seulement), posé par le SEUL écrivain du graphe (`graph/store.ts`) — ce
 * module n'écrit lui-même aucune table. Tout le reste — fusions douteuses, opérations nées d'une simple
 * association, dates divergentes, relations manquantes — touche une décision
 * de l'utilisateur : jamais corrigé d'office.
 *
 * GARANTIES
 *   · ISOLATION : chaque requête est bornée au compte (`$1`) ; un compte, une
 *     transaction ; l'échec d'un compte n'arrête pas les autres.
 *   · IDEMPOTENT ET REPRENABLE : la correction ne s'applique qu'à ce qui
 *     manque encore ; un second passage n'écrit rien ; un passage interrompu
 *     se relance tel quel (ou à partir d'un compte donné).
 *   · NON DESTRUCTIF : aucune ligne n'est supprimée. La transaction vérifie
 *     avant de valider qu'aucun justificatif, aucun lien direct document ↔
 *     événement, aucun événement, aucune opération, aucune relation n'a
 *     disparu ; sinon elle est ANNULÉE (`STOCK_AUDIT_INVARIANT`).
 *   · ANONYMISÉ : le rapport ne contient que des codes, des nombres et des
 *     identifiants techniques — jamais un titre, un nom, un montant ni un texte.
 *   · Aucune IA, aucun rappel, aucune carte « À traiter » créés par l'audit.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { GroupingRunner } from '../grouping/runner';
import type { GraphFinding } from '../graph/store';
import { syncedOperationDateField } from '../graph/fact-date-sync';
import { INVENTORY_MEASURES } from './inventory';

type Row = Record<string, unknown>;

/** Devenir d'une anomalie (voir l'en-tête). */
export type StockDisposition = 'CERTAIN_FIX' | 'ARBITRATION' | 'REPORT';
export type StockObject = 'OPERATION' | 'AGENDA_ITEM' | 'AGENDA_LINK' | 'DIRECT_LINK' | 'RELATION';

export const STOCK_ANOMALY_CODES = [
  'OPERATION_CREATED_BY_SIMPLE_LINK', 'OPERATIONS_MERGED_BY_SIMPLE_LINK',
  'INSURANCE_CLAIM_MERGED', 'FINANCING_ACQUISITION_MERGED', 'CLAIM_DETAILS_ON_NON_CLAIM',
  'DIRECT_LINK_WITHOUT_PROVENANCE', 'DIRECT_LINK_TARGET_UNAVAILABLE', 'DIRECT_LINK_PROPAGATED_WITHOUT_OPERATION',
  'RELATION_PAIR_DUPLICATED', 'CLAIM_CONTRACT_WITHOUT_RELATION', 'FINANCING_ACQUISITION_WITHOUT_RELATION',
  'FACT_DATE_DIVERGENT', 'DATE_PRESUMED_PROPAGATED',
  'LEGACY_ROLE_STILL_STORED',
  'LEGACY_LINK_RESTORABLE', 'LEGACY_LINK_BLOCKED_BY_DECISION',
] as const;
export type StockAnomalyCode = (typeof STOCK_ANOMALY_CODES)[number];

export interface StockAnomalyDescription {
  disposition: StockDisposition;
  object: StockObject;
  /** Libellé d'EXPLOITATION (rapport) — jamais affiché à l'utilisateur. */
  label: string;
}

export const STOCK_ANOMALY_DESCRIPTIONS: Readonly<Record<StockAnomalyCode, StockAnomalyDescription>> = {
  OPERATION_CREATED_BY_SIMPLE_LINK: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Opération active fondée seulement sur un ancien lien document ↔ événement (avant #806, ce lien créait une opération).',
  },
  OPERATIONS_MERGED_BY_SIMPLE_LINK: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Opération fusionnée dans une autre par l’ancien geste d’association de deux événements (avant #806, ce geste fusionnait).',
  },
  INSURANCE_CLAIM_MERGED: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Un contrat et un sinistre ont été fusionnés : ce sont deux opérations distinctes, à séparer avec l’utilisateur.',
  },
  FINANCING_ACQUISITION_MERGED: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Un financement et une acquisition ont été fusionnés : ce sont deux opérations distinctes, à séparer avec l’utilisateur.',
  },
  CLAIM_DETAILS_ON_NON_CLAIM: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Détails de sinistre portés par une opération active qui n’est pas un sinistre.',
  },
  DIRECT_LINK_WITHOUT_PROVENANCE: {
    disposition: 'REPORT', object: 'DIRECT_LINK',
    label: 'Lien direct document ↔ événement sans aucune justification enregistrée (le lien est conservé).',
  },
  DIRECT_LINK_TARGET_UNAVAILABLE: {
    disposition: 'REPORT', object: 'DIRECT_LINK',
    label: 'Lien direct d’un événement vers un justificatif supprimé ou d’un autre compte (le lien est conservé, jamais lu).',
  },
  DIRECT_LINK_PROPAGATED_WITHOUT_OPERATION: {
    disposition: 'REPORT', object: 'DIRECT_LINK',
    label: 'Lien document ↔ événement qui n’existe que par l’ancienne propagation d’une opération, alors que l’événement n’a plus d’opération.',
  },
  RELATION_PAIR_DUPLICATED: {
    disposition: 'REPORT', object: 'RELATION',
    label: 'Plusieurs relations enregistrées pour la même paire d’opérations.',
  },
  CLAIM_CONTRACT_WITHOUT_RELATION: {
    disposition: 'REPORT', object: 'OPERATION',
    label: 'Sinistre relié à son contrat par le seul lien historique du formulaire, sans relation entre opérations (le graphe le lit déjà).',
  },
  FINANCING_ACQUISITION_WITHOUT_RELATION: {
    disposition: 'ARBITRATION', object: 'OPERATION',
    label: 'Financement et acquisition du même bien sans relation entre eux : à relier si l’utilisateur le confirme (rien n’est déduit).',
  },
  FACT_DATE_DIVERGENT: {
    disposition: 'ARBITRATION', object: 'AGENDA_LINK',
    label: 'La date de l’opération et celle de l’événement qui porte le même fait diffèrent (aucune des deux n’est écrasée).',
  },
  DATE_PRESUMED_PROPAGATED: {
    disposition: 'REPORT', object: 'AGENDA_LINK',
    label: 'Présomption : événement automatique non modifié, non porteur du fait, daté exactement comme le fait de son opération.',
  },
  LEGACY_ROLE_STILL_STORED: {
    disposition: 'REPORT', object: 'AGENDA_ITEM',
    label: 'Ancien rôle « principal » encore STOCKÉ dans la colonne historique (nombre seul ; elle n’est plus lue par l’application ; rien n’est retiré).',
  },
  LEGACY_LINK_RESTORABLE: {
    disposition: 'CERTAIN_FIX', object: 'AGENDA_ITEM',
    label: 'Événement rattaché par la colonne historique sans aucun lien dans le graphe ni refus : le lien manquant peut être posé.',
  },
  LEGACY_LINK_BLOCKED_BY_DECISION: {
    disposition: 'ARBITRATION', object: 'AGENDA_ITEM',
    label: 'Événement rattaché par la colonne historique, mais retiré ou refusé dans le graphe : la décision n’est pas contournée.',
  },
};

const OP_ACTIVE = (a: string): string => `${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;

/**
 * Événement de la colonne historique SANS lien actif dans le graphe (même
 * constat que `LEGACY_LINK_MISSING` du contrôle du graphe), opération ACTIVE du
 * même compte. `libre` : aucune ligne du graphe pour la paire ET aucun refus de
 * l'utilisateur — le seul cas corrigé.
 */
const LEGACY_MISSING_SQL = `
  SELECT i.id AS id, i.business_operation_id AS op,
         (NOT EXISTS (SELECT 1 FROM business_operation_agenda_links l WHERE l.operation_id = i.business_operation_id AND l.agenda_item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM business_operation_match_decisions d
                           WHERE d.account_id = $1 AND d.candidate_operation_id = i.business_operation_id AND d.source_kind = 'AGENDA'
                             AND d.source_entity_key = i.id::text AND d.decision = 'REJECTED' AND d.active)) AS libre
    FROM agenda_items i
    JOIN business_operations o ON o.id = i.business_operation_id AND o.account_id = i.account_id AND ${OP_ACTIVE('o')}
   WHERE i.account_id = $1
     AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links l
                      WHERE l.operation_id = i.business_operation_id AND l.agenda_item_id = i.id AND l.account_id = i.account_id AND l.state = 'ACTIVE')`;

/** Mesures SQL simples : `$1` = compte ; chaque ligne rend `id` (objet de l'anomalie). Lecture seule. */
const SQL_MEASURES: ReadonlyArray<[StockAnomalyCode, string]> = [
  ['OPERATION_CREATED_BY_SIMPLE_LINK', `
    SELECT o.id FROM business_operations o
     WHERE o.account_id = $1 AND ${OP_ACTIVE('o')}
       AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = $1 AND s.active)
       AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.account_id = $1 AND s.active
                          AND NOT (s.source_kind = 'AGENDA' AND s.locator->>'grouping' = 'USER_DOCUMENT_LINK'))`],
  ['OPERATIONS_MERGED_BY_SIMPLE_LINK', `
    SELECT DISTINCT o.id FROM business_operations o
      JOIN business_operation_history h ON h.operation_id = o.id AND h.account_id = o.account_id
       AND h.event_type = 'MERGED' AND h.reason_code IN ('USER_AGENDA_LINK', 'USER_DOCUMENT_AGENDA_LINK')
     WHERE o.account_id = $1 AND o.merged_into_operation_id IS NOT NULL`],
  ['INSURANCE_CLAIM_MERGED', `
    SELECT m.id FROM business_operations m JOIN business_operations c ON c.id = m.merged_into_operation_id AND c.account_id = m.account_id
     WHERE m.account_id = $1 AND ((m.type_code = 'CLAIM' AND c.type_code = 'CONTRACT') OR (m.type_code = 'CONTRACT' AND c.type_code = 'CLAIM'))`],
  ['FINANCING_ACQUISITION_MERGED', `
    SELECT m.id FROM business_operations m JOIN business_operations c ON c.id = m.merged_into_operation_id AND c.account_id = m.account_id
     WHERE m.account_id = $1 AND ((m.type_code = 'FINANCING' AND c.type_code = 'ACQUISITION') OR (m.type_code = 'ACQUISITION' AND c.type_code = 'FINANCING'))`],
  ['CLAIM_DETAILS_ON_NON_CLAIM', `
    SELECT o.id FROM business_operation_claim_details d JOIN business_operations o ON o.id = d.operation_id
     WHERE o.account_id = $1 AND ${OP_ACTIVE('o')} AND o.type_code IS DISTINCT FROM 'CLAIM'`],
  ['DIRECT_LINK_WITHOUT_PROVENANCE', `
    SELECT l.id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
     WHERE i.account_id = $1 AND cardinality(l.provenances) = 0`],
  ['DIRECT_LINK_TARGET_UNAVAILABLE', `
    SELECT l.id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id JOIN asset_files f ON f.id = l.asset_file_id
     WHERE i.account_id = $1 AND (f.account_id IS DISTINCT FROM i.account_id OR f.deleted_at IS NOT NULL)`],
  ['DIRECT_LINK_PROPAGATED_WITHOUT_OPERATION', `
    SELECT l.id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
     WHERE i.account_id = $1 AND l.provenances = ARRAY['OPERATION_PRINCIPAL']::text[]
       AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links g JOIN business_operations o ON o.id = g.operation_id AND o.account_id = g.account_id AND ${OP_ACTIVE('o')}
                        WHERE g.account_id = $1 AND g.agenda_item_id = i.id AND g.state = 'ACTIVE')`],
  ['RELATION_PAIR_DUPLICATED', `
    SELECT min(r.id) AS id FROM business_operation_relations r WHERE r.account_id = $1
     GROUP BY LEAST(r.from_operation_id, r.to_operation_id), GREATEST(r.from_operation_id, r.to_operation_id) HAVING count(*) > 1`],
  ['CLAIM_CONTRACT_WITHOUT_RELATION', `
    SELECT o.id FROM business_operation_claim_details d
      JOIN business_operations o ON o.id = d.operation_id AND ${OP_ACTIVE('o')}
      JOIN business_operations c ON c.id = d.insurance_contract_operation_id AND c.account_id = o.account_id AND ${OP_ACTIVE('c')}
     WHERE o.account_id = $1
       AND NOT EXISTS (SELECT 1 FROM business_operation_relations r WHERE r.account_id = $1
                          AND LEAST(r.from_operation_id, r.to_operation_id) = LEAST(o.id, c.id) AND GREATEST(r.from_operation_id, r.to_operation_id) = GREATEST(o.id, c.id))`],
  ['FINANCING_ACQUISITION_WITHOUT_RELATION', `
    SELECT DISTINCT f.id FROM business_operations f
      JOIN business_operation_asset_links fa ON fa.operation_id = f.id AND fa.account_id = f.account_id AND fa.active
      JOIN business_operation_asset_links aa ON aa.asset_id = fa.asset_id AND aa.account_id = f.account_id AND aa.active
      JOIN business_operations a ON a.id = aa.operation_id AND a.account_id = f.account_id AND a.type_code = 'ACQUISITION' AND ${OP_ACTIVE('a')}
     WHERE f.account_id = $1 AND f.type_code = 'FINANCING' AND ${OP_ACTIVE('f')}
       AND NOT EXISTS (SELECT 1 FROM business_operation_relations r WHERE r.account_id = $1
                          AND LEAST(r.from_operation_id, r.to_operation_id) = LEAST(f.id, a.id) AND GREATEST(r.from_operation_id, r.to_operation_id) = GREATEST(f.id, a.id))`],
];

/** Liens actifs du graphe avec ce qu'il faut pour comparer les dates d'un même fait (lecture seule, bornée au compte). */
const FACT_LINKS_SQL = `
  SELECT l.id, l.operation_id AS op, l.agenda_item_id AS item, l.fact_key, o.type_code, o.status,
         o.realized_date::text AS realized_date, o.planned_date::text AS planned_date,
         i.start_date::text AS start_date, (i.is_automatic AND NOT i.is_automatic_modified) AS automatique
    FROM business_operation_agenda_links l
    JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND ${OP_ACTIVE('o')}
    JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
   WHERE l.account_id = $1 AND l.state = 'ACTIVE'`;

export interface FactLinkRow {
  id: number; operationId: number; agendaItemId: number; factKey: string | null; typeCode: string | null; status: string | null;
  realizedDate: string | null; plannedDate: string | null; startDate: string | null; automatic: boolean;
}

/**
 * Dates d'un même fait (pur) — s'appuie sur la règle EXISTANTE de la
 * synchronisation (`syncedOperationDateField`, lot 116C §5), jamais sur une
 * règle propre :
 *   · `divergent` : l'événement PORTEUR du fait et l'opération montrent deux
 *     dates différentes pour ce fait ;
 *   · `presumedPropagated` : un AUTRE événement de la même opération, non
 *     porteur, automatique et jamais modifié, porte exactement la date du fait
 *     alors que le fait a déjà son porteur daté — une simple présomption.
 */
export function classifyFactDates(links: readonly FactLinkRow[]): { divergent: number[]; presumedPropagated: number[] } {
  const divergent: number[] = [];
  const presumedPropagated: number[] = [];
  const dateDuFait = new Map<number, string>();
  for (const l of links) {
    const champ = syncedOperationDateField(l.typeCode, l.status, l.factKey);
    if (!champ) continue;
    const dateOperation = champ === 'realizedDate' ? l.realizedDate : l.plannedDate;
    if (!dateOperation || !l.startDate) continue;
    if (dateOperation !== l.startDate) divergent.push(l.id);
    else dateDuFait.set(l.operationId, dateOperation);
  }
  for (const l of links) {
    if (l.factKey !== null || !l.automatic || !l.startDate) continue;
    if (dateDuFait.get(l.operationId) === l.startDate) presumedPropagated.push(l.id);
  }
  return { divergent: divergent.sort((a, b) => a - b), presumedPropagated: presumedPropagated.sort((a, b) => a - b) };
}

/** Volumétrie d'un compte (nombres seuls). `$1` = compte. */
const VOLUMETRY_SQL = `
  SELECT
    (SELECT count(*) FROM business_operations o WHERE o.account_id = $1)::int AS operations,
    (SELECT count(*) FROM business_operations o WHERE o.account_id = $1 AND ${OP_ACTIVE('o')})::int AS operations_actives,
    (SELECT count(*) FROM business_operation_relations r WHERE r.account_id = $1)::int AS relations,
    (SELECT count(*) FROM business_operation_relations r WHERE r.account_id = $1 AND r.state = 'ACTIVE')::int AS relations_actives,
    (SELECT count(*) FROM business_operation_relations r WHERE r.account_id = $1 AND r.state = 'REJECTED')::int AS relations_refusees,
    (SELECT count(*) FROM business_operation_agenda_links l WHERE l.account_id = $1)::int AS liens_agenda,
    (SELECT count(*) FROM business_operation_agenda_links l WHERE l.account_id = $1 AND l.state = 'ACTIVE')::int AS liens_agenda_actifs,
    (SELECT count(*) FROM agenda_items i WHERE i.account_id = $1)::int AS evenements,
    (SELECT count(*) FROM agenda_items i WHERE i.account_id = $1 AND i.business_operation_id IS NOT NULL)::int AS evenements_colonne_historique,
    (SELECT count(*) FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = $1)::int AS liens_directs,
    (SELECT count(*) FROM asset_files f WHERE f.account_id = $1 AND f.deleted_at IS NULL)::int AS justificatifs,
    (SELECT count(*) FROM business_operation_documents d WHERE d.account_id = $1 AND d.active)::int AS justificatifs_operation,
    (SELECT count(*) FROM business_operation_match_decisions d WHERE d.account_id = $1 AND d.active AND d.decision = 'REJECTED')::int AS refus_utilisateur,
    (SELECT count(*) FROM notification_outbox n WHERE n.account_id = $1)::int AS rappels,
    (SELECT count(*) FROM to_process_actions a WHERE a.account_id = $1 AND a.resolved_at IS NULL)::int AS cartes_ouvertes`;

export type StockVolumetry = Readonly<Record<string, number>>;

/** Compteurs qui ne doivent JAMAIS baisser pendant une application (rien n'est supprimé). */
export const NEVER_DECREASING: readonly string[] = [
  'operations', 'operations_actives', 'relations', 'relations_actives', 'relations_refusees', 'liens_agenda', 'liens_agenda_actifs',
  'evenements', 'evenements_colonne_historique', 'liens_directs', 'justificatifs', 'justificatifs_operation', 'refus_utilisateur',
];
/** Compteurs qui ne doivent pas BOUGER du tout (l'audit ne crée ni rappel, ni carte, ni opération, ni relation). */
export const NEVER_CHANGING: readonly string[] = [
  'operations', 'operations_actives', 'relations', 'relations_actives', 'relations_refusees', 'evenements', 'evenements_colonne_historique',
  'liens_directs', 'justificatifs', 'justificatifs_operation', 'refus_utilisateur', 'rappels', 'cartes_ouvertes',
];

/** Écarts de volumétrie interdits entre avant et après (pur) ; liste vide : rien n'a été perdu ni créé à tort. */
export function volumetryViolations(before: StockVolumetry, after: StockVolumetry): string[] {
  const out: string[] = [];
  for (const k of NEVER_DECREASING) if ((after[k] ?? 0) < (before[k] ?? 0)) out.push(`${k}:${before[k] ?? 0}->${after[k] ?? 0}`);
  for (const k of NEVER_CHANGING) if ((after[k] ?? 0) !== (before[k] ?? 0) && !out.some((x) => x.startsWith(`${k}:`))) out.push(`${k}:${before[k] ?? 0}->${after[k] ?? 0}`);
  return out;
}

export interface StockAnomalyLine {
  code: StockAnomalyCode;
  disposition: StockDisposition;
  object: StockObject;
  label: string;
  count: number;
  /** Identifiants techniques (au plus `STOCK_SAMPLE`), triés ; vide pour une mesure rendue en nombre seul. */
  sample: number[];
}

export interface StockAuditReport {
  accountId: number;
  mode: 'SIMULATION' | 'APPLIED';
  /** Écarts du graphe, tels que le contrôle `COH-OPERATION-GRAPH` les constate (aucune réparation). */
  graphFindings: GraphFinding[];
  /** Anomalies propres au stock, celles à zéro comprises (un rapport dit aussi ce qui est sain). */
  anomalies: StockAnomalyLine[];
  volumetryBefore: StockVolumetry;
  /** Simulation : identique à `volumetryBefore` (rien n'a été écrit). */
  volumetryAfter: StockVolumetry;
  /** Corrections certaines : ce qui serait fait (simulation) ou ce qui a été fait (application). */
  fixes: { legacyLinksToRestore: number; legacyLinksRestored: number };
  /** Cas laissés à une décision (somme des anomalies `ARBITRATION`). */
  arbitration: number;
}

/** Identifiants conservés au plus par anomalie dans le rapport. */
export const STOCK_SAMPLE = 20;
export const STOCK_AUDIT_FIX_REASON = 'STOCK_AUDIT_LEGACY_LINK_RESTORED';
export const STOCK_AUDIT_CORRELATION = 'stock-audit-806';

const num = (v: unknown): number => Number(v);
const txt = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function ligne(code: StockAnomalyCode, ids: readonly number[]): StockAnomalyLine {
  const d = STOCK_ANOMALY_DESCRIPTIONS[code];
  const tries = [...new Set(ids)].sort((a, b) => a - b);
  return { code, disposition: d.disposition, object: d.object, label: d.label, count: tries.length, sample: tries.slice(0, STOCK_SAMPLE) };
}

async function volumetrie(r: GroupingRunner, accountId: number): Promise<StockVolumetry> {
  const [x] = await r.q<Row>(VOLUMETRY_SQL, [accountId]);
  return Object.fromEntries(Object.entries(x ?? {}).map(([k, v]) => [k, num(v)]));
}

/** Toutes les lectures de l'audit, dans la transaction fournie (aucune écriture). */
async function lire(r: GroupingRunner, accountId: number): Promise<{
  graphFindings: GraphFinding[]; anomalies: StockAnomalyLine[]; restaurables: Array<{ itemId: number; operationId: number }>;
}> {
  const { auditOperationGraph } = await import('../graph/store');
  const graphFindings = await auditOperationGraph(r, accountId);
  const parCode = new Map<StockAnomalyCode, number[]>();
  for (const [code, sql] of SQL_MEASURES) parCode.set(code, (await r.q<Row>(sql, [accountId])).map((x) => num(x.id)));
  const faits = (await r.q<Row>(FACT_LINKS_SQL, [accountId])).map((x): FactLinkRow => ({
    id: num(x.id), operationId: num(x.op), agendaItemId: num(x.item), factKey: txt(x.fact_key), typeCode: txt(x.type_code), status: txt(x.status),
    realizedDate: txt(x.realized_date), plannedDate: txt(x.planned_date), startDate: txt(x.start_date), automatic: x.automatique === true,
  }));
  const dates = classifyFactDates(faits);
  parCode.set('FACT_DATE_DIVERGENT', dates.divergent);
  parCode.set('DATE_PRESUMED_PROPAGATED', dates.presumedPropagated);
  // Ancien rôle « principal » encore stocké : mesuré par l'INVENTAIRE de migration existant (`inventory.ts`, seul
  // module admis à lire la colonne historique — garde L114OR-G03). Un NOMBRE seulement, sans identifiant. Le rôle
  // « complément » n'est pas compté : le déclencheur de compatibilité de la base (0652) le pose sur tout événement rattaché.
  const mesureRole = INVENTORY_MEASURES.find((m) => m.key === 'principal');
  const ligneRole: Row = mesureRole ? ((await r.q<Row>(mesureRole.sql, [accountId]))[0] ?? {}) : {};
  const anciensRoles = num(ligneRole.principal ?? 0);
  const manquants = await r.q<Row>(LEGACY_MISSING_SQL, [accountId]);
  const restaurables = manquants.filter((x) => x.libre === true).map((x) => ({ itemId: num(x.id), operationId: num(x.op) }))
    .sort((a, b) => a.itemId - b.itemId || a.operationId - b.operationId);
  parCode.set('LEGACY_LINK_RESTORABLE', restaurables.map((x) => x.itemId));
  parCode.set('LEGACY_LINK_BLOCKED_BY_DECISION', manquants.filter((x) => x.libre !== true).map((x) => num(x.id)));
  const anomalies = STOCK_ANOMALY_CODES.map((c) => (c === 'LEGACY_ROLE_STILL_STORED' ? { ...ligne(c, []), count: anciensRoles } : ligne(c, parCode.get(c) ?? [])));
  return { graphFindings, anomalies, restaurables };
}

const sommeArbitrage = (a: readonly StockAnomalyLine[]): number => a.filter((x) => x.disposition === 'ARBITRATION').reduce((s, x) => s + x.count, 0);

/**
 * Pose les liens du graphe manquants (cas CERTAIN), par le SEUL écrivain du
 * graphe (`graph/store.ts › restoreMissingLegacyAgendaLink`, qui journalise) :
 * ce module n'écrit lui-même aucune table. Rend le nombre de liens réellement
 * posés ; une ligne apparue entre-temps n'est jamais touchée.
 */
async function restaurer(r: GroupingRunner, accountId: number, cibles: ReadonlyArray<{ itemId: number; operationId: number }>): Promise<number> {
  const { restoreMissingLegacyAgendaLink } = await import('../graph/store');
  let poses = 0;
  for (const c of cibles) {
    if (await restoreMissingLegacyAgendaLink(r, accountId, {
      agendaItemId: c.itemId, operationId: c.operationId, reasonCode: STOCK_AUDIT_FIX_REASON, channel: 'STOCK_AUDIT', correlationId: STOCK_AUDIT_CORRELATION,
    })) poses += 1;
  }
  return poses;
}

export interface StockAuditOptions {
  /** `true` : applique la seule correction certaine. Absent ou `false` : SIMULATION (transaction en lecture seule). */
  apply?: boolean;
}

/**
 * Audit du stock d'UN compte. Simulation par défaut ; `apply` pose les liens
 * du graphe manquants (cas certain) dans une transaction verrouillée au compte,
 * annulée si la volumétrie montre la moindre perte.
 */
export async function auditAccountStock(accountId: number, options: StockAuditOptions = {}): Promise<StockAuditReport> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('INVALID_ACCOUNT_ID');
  const { pgClient } = await import('@/db');
  const { postgresRunner, lockGroupingAccount } = await import('../grouping/runner');
  if (options.apply !== true) {
    return (await pgClient.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      const r = postgresRunner(tx as unknown as { unsafe: (t: string, p?: never[]) => Promise<unknown> });
      const avant = await volumetrie(r, accountId);
      const lu = await lire(r, accountId);
      const rapport: StockAuditReport = {
        accountId, mode: 'SIMULATION', graphFindings: lu.graphFindings, anomalies: lu.anomalies, volumetryBefore: avant, volumetryAfter: avant,
        fixes: { legacyLinksToRestore: lu.restaurables.length, legacyLinksRestored: 0 }, arbitration: sommeArbitrage(lu.anomalies),
      };
      return rapport;
    })) as unknown as StockAuditReport;
  }
  return (await pgClient.begin(async (tx) => {
    const r = postgresRunner(tx as unknown as { unsafe: (t: string, p?: never[]) => Promise<unknown> });
    await lockGroupingAccount(r, accountId);
    const avant = await volumetrie(r, accountId);
    const lu = await lire(r, accountId);
    const poses = await restaurer(r, accountId, lu.restaurables);
    const apres = await volumetrie(r, accountId);
    // Garde-fou : rien n'a disparu, rien d'autre que des liens du graphe n'a été créé — sinon TOUT est annulé.
    const ecarts = volumetryViolations(avant, apres);
    const attendus = (apres.liens_agenda ?? 0) - (avant.liens_agenda ?? 0);
    if (ecarts.length || attendus !== poses) throw new Error(`STOCK_AUDIT_INVARIANT (compte ${accountId}) : ${[...ecarts, `liens_poses:${poses}/${attendus}`].join(', ')}`);
    const relu = await lire(r, accountId);
    const rapport: StockAuditReport = {
      accountId, mode: 'APPLIED', graphFindings: relu.graphFindings, anomalies: relu.anomalies, volumetryBefore: avant, volumetryAfter: apres,
      fixes: { legacyLinksToRestore: lu.restaurables.length, legacyLinksRestored: poses }, arbitration: sommeArbitrage(relu.anomalies),
    };
    return rapport;
  })) as unknown as StockAuditReport;
}

/** Comptes qui ont au moins une opération ou un événement rattaché (ordre stable). `fromAccountId` : reprise après interruption. */
export async function stockAuditAccounts(fromAccountId = 0): Promise<number[]> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT account_id FROM business_operations WHERE account_id >= $1
      UNION SELECT account_id FROM agenda_items WHERE business_operation_id IS NOT NULL AND account_id >= $1
      ORDER BY 1`, [Math.max(0, Math.floor(fromAccountId))] as never[])) as unknown as Row[];
  return rows.map((x) => num(x.account_id));
}

export interface StockAuditSummary {
  mode: 'SIMULATION' | 'APPLIED';
  accounts: number;
  accountsWithAnomalies: number;
  failedAccounts: number[];
  totals: Record<string, number>;
  graphTotals: Record<string, number>;
  legacyLinksToRestore: number;
  legacyLinksRestored: number;
  arbitration: number;
}

/** Synthèse anonymisée d'une série de rapports (pure) : des codes et des nombres. */
export function summarizeStockAudit(reports: readonly StockAuditReport[], failedAccounts: readonly number[] = [], mode: 'SIMULATION' | 'APPLIED' = 'SIMULATION'): StockAuditSummary {
  const totals: Record<string, number> = Object.fromEntries(STOCK_ANOMALY_CODES.map((c) => [c, 0]));
  const graphTotals: Record<string, number> = {};
  let aRestaurer = 0;
  let restaures = 0;
  let arbitrage = 0;
  let concernes = 0;
  for (const r of reports) {
    for (const a of r.anomalies) totals[a.code] = (totals[a.code] ?? 0) + a.count;
    for (const f of r.graphFindings) graphTotals[f.code] = (graphTotals[f.code] ?? 0) + f.count;
    aRestaurer += r.fixes.legacyLinksToRestore;
    restaures += r.fixes.legacyLinksRestored;
    arbitrage += r.arbitration;
    if (r.graphFindings.length || r.anomalies.some((a) => a.count > 0)) concernes += 1;
  }
  return {
    mode, accounts: reports.length + failedAccounts.length, accountsWithAnomalies: concernes, failedAccounts: [...failedAccounts].sort((a, b) => a - b),
    totals, graphTotals, legacyLinksToRestore: aRestaurer, legacyLinksRestored: restaures, arbitration: arbitrage,
  };
}

/**
 * Série de comptes : chacun dans SA transaction ; l'échec d'un compte est noté
 * et n'arrête pas les autres (le compte en échec n'a rien écrit : transaction
 * annulée). `onReport` : écriture au fil de l'eau (reprise après interruption).
 */
export async function auditStock(accountIds: readonly number[], options: StockAuditOptions & { onReport?: (r: StockAuditReport) => void | Promise<void> } = {}): Promise<{
  reports: StockAuditReport[]; failed: Array<{ accountId: number; error: string }>; summary: StockAuditSummary;
}> {
  const reports: StockAuditReport[] = [];
  const failed: Array<{ accountId: number; error: string }> = [];
  for (const accountId of [...new Set(accountIds)].sort((a, b) => a - b)) {
    try {
      const r = await auditAccountStock(accountId, { apply: options.apply === true });
      reports.push(r);
      await options.onReport?.(r);
    } catch (e) {
      // Message technique seulement (code, compte) : jamais une donnée du compte.
      failed.push({ accountId, error: ((e as Error).message ?? 'ERREUR').slice(0, 300) });
    }
  }
  return { reports, failed, summary: summarizeStockAudit(reports, failed.map((f) => f.accountId), options.apply === true ? 'APPLIED' : 'SIMULATION') };
}
