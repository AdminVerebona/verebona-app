/**
 * GRAPHE CANONIQUE des événements de référence — LECTURES SYMÉTRIQUES
 * (lot 114O, carte Trello #744, CDC « Opérations / Agenda V2.0 » §4, §9, §12,
 * §20 ; lot B).
 *
 * Lecteur canonisé des relations d'un événement de référence, destiné à la
 * future fiche (lot D), à l'Agenda / la Timeline (lot E) et à l'Assistant :
 *   · relations vers d'AUTRES événements de référence, lues dans les DEUX
 *     sens à partir de la même ligne (financement → acquisition lu depuis
 *     l'acquisition comme « financé par ») ;
 *   · le lien spécialisé existant Sinistre → contrat d'assurance
 *     (`business_operation_claim_details.insurance_contract_operation_id`) est
 *     LU ici comme une relation (source `CLAIM_DETAILS`), jamais recopié :
 *     une seule source de vérité (CDC §4) ;
 *   · éléments d'Agenda liés (N↔N) : TOUS, sans rôle « principal », chacun à
 *     SA date propre (jamais la date de l'événement de référence) ; un
 *     élément partagé apparaît une fois par événement de référence, avec la
 *     même identité ;
 *   · événements de référence d'un élément d'Agenda (lecture inverse).
 *
 * Règles de lecture :
 *   · bornée au compte demandé (aucune ligne d'un autre compte, AC59) ;
 *   · identité CANONIQUE : un ancien identifiant fusionné est redirigé
 *     (`redirectedFrom`) ; un événement de référence invalidé ou fusionné
 *     n'apparaît jamais comme extrémité ;
 *   · aucune limite silencieuse : toutes les lignes sont rendues ;
 *   · aucune IA, aucune écriture.
 * Le libellé rendu est le libellé utilisateur existant (`referenceEventLabel`,
 * jamais le mot « Opération »).
 */
import { db } from '@/db';
import { drizzleRunner, type GroupingRunner } from '../grouping/runner';
import type { GraphEvidence, GraphOrigin, OperationRelationNature } from './model';

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);

export interface GraphOperationRef {
  operationId: number;
  typeCode: string | null;
  /** Libellé utilisateur (jamais « Opération »). */
  label: string;
}

export interface GraphRelationView {
  /** Identifiant de la relation du graphe ; null pour une relation spécialisée lue (CLAIM_DETAILS). */
  relationId: number | null;
  source: 'GRAPH' | 'CLAIM_DETAILS';
  nature: OperationRelationNature | 'CLAIM_CONTRACT';
  /** OUTGOING : l'événement lu est l'origine (le financement, le sinistre) ; INCOMING : il est la cible ; UNDIRECTED : association. */
  direction: 'OUTGOING' | 'INCOMING' | 'UNDIRECTED';
  other: GraphOperationRef;
  origin: GraphOrigin | null;
  version: number | null;
  evidence: GraphEvidence[];
  validFrom: string | null;
  validTo: string | null;
  decidedAt: string | null;
}

export interface GraphAgendaItemView {
  agendaItemId: number;
  title: string;
  /** Date PROPRE de l'élément (null : élément sans date). */
  startDate: string | null;
  origin: GraphOrigin;
  /** Lien aussi porté par la colonne historique (vu des écrans existants). */
  legacyColumn: boolean;
  /** Nombre d'événements de référence ACTIFS auxquels l'élément est lié (≥ 2 : élément partagé). */
  sharedWith: number;
  version: number;
}

export interface OperationGraphView {
  operationId: number;
  /** Ancien identifiant demandé, si l'événement de référence a été fusionné. */
  redirectedFrom: number | null;
  relations: GraphRelationView[];
  /** Événements de référence que l'utilisateur a REFUSÉ d'associer à celui-ci. */
  refusedOperationIds: number[];
  agendaItems: GraphAgendaItemView[];
  /** Éléments d'Agenda que l'utilisateur a refusé de rattacher à celui-ci. */
  refusedAgendaItemIds: number[];
}

/** Événement de référence ACTIF (alias SQL `a`) : ni invalidé, ni fusionné. */
const actif = (a: string): string => `${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;

async function label(o: Row): Promise<string> {
  const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  return referenceEventLabel({
    typeCode: (o.type_code as string | null) ?? null, technicalLabel: (o.technical_label as string | null) ?? null, provider: (o.provider as string | null) ?? null,
  });
}

/**
 * Graphe d'UN événement de référence du compte. null : introuvable dans ce
 * compte, ou invalidé sans redirection.
 */
export async function readOperationGraph(accountId: number, operationId: number, runner: GroupingRunner = drizzleRunner(db)): Promise<OperationGraphView | null> {
  const { BusinessOperationReadService } = await import('../read-service');
  const resolu = await new BusinessOperationReadService().getOperation(accountId, operationId);
  if (!resolu || resolu.operation.invalidatedAt !== null) return null;
  const id = resolu.operation.id;

  const rel = await runner.q<Row>(
    `SELECT rel.id, rel.from_operation_id, rel.to_operation_id, rel.nature, rel.state, rel.origin, rel.version, rel.evidence,
            rel.valid_from::text AS valid_from, rel.valid_to::text AS valid_to, rel.decided_at::text AS decided_at,
            o.id AS other_id, o.type_code, o.technical_label, o.provider, (${actif('o')}) AS other_active
       FROM business_operation_relations rel
       JOIN business_operations o ON o.account_id = rel.account_id
        AND o.id = CASE WHEN rel.from_operation_id = $2 THEN rel.to_operation_id ELSE rel.from_operation_id END
      WHERE rel.account_id = $1 AND (rel.from_operation_id = $2 OR rel.to_operation_id = $2) AND rel.state IN ('ACTIVE', 'REJECTED')
      ORDER BY rel.id`, [accountId, id]);
  const relations: GraphRelationView[] = [];
  const refusedOperationIds: number[] = [];
  for (const x of rel) {
    if (x.state === 'REJECTED') { refusedOperationIds.push(n(x.other_id)); continue; }
    if (x.other_active !== true) continue;
    const nature = x.nature as OperationRelationNature;
    relations.push({
      relationId: n(x.id), source: 'GRAPH', nature,
      direction: nature === 'ASSOCIATED' ? 'UNDIRECTED' : n(x.from_operation_id) === id ? 'OUTGOING' : 'INCOMING',
      other: { operationId: n(x.other_id), typeCode: (x.type_code as string | null) ?? null, label: await label(x) },
      origin: x.origin as GraphOrigin, version: n(x.version), evidence: (Array.isArray(x.evidence) ? x.evidence : []) as GraphEvidence[],
      validFrom: (x.valid_from as string | null) ?? null, validTo: (x.valid_to as string | null) ?? null, decidedAt: (x.decided_at as string | null) ?? null,
    });
  }
  // Relation spécialisée existante : Sinistre → contrat d'assurance (lue, jamais recopiée), dans les deux sens.
  const police = await runner.q<Row>(
    `SELECT k.operation_id AS claim_id, k.insurance_contract_operation_id AS contract_id, o.id AS other_id, o.type_code, o.technical_label, o.provider
       FROM business_operation_claim_details k
       JOIN business_operations c ON c.id = k.operation_id AND c.account_id = $1 AND ${actif('c')}
       JOIN business_operations o ON o.account_id = $1 AND ${actif('o')}
        AND o.id = CASE WHEN k.operation_id = $2 THEN k.insurance_contract_operation_id ELSE k.operation_id END
      WHERE k.insurance_contract_operation_id IS NOT NULL AND (k.operation_id = $2 OR k.insurance_contract_operation_id = $2)
      ORDER BY k.operation_id`, [accountId, id]);
  for (const x of police) {
    relations.push({
      relationId: null, source: 'CLAIM_DETAILS', nature: 'CLAIM_CONTRACT', direction: n(x.claim_id) === id ? 'OUTGOING' : 'INCOMING',
      other: { operationId: n(x.other_id), typeCode: (x.type_code as string | null) ?? null, label: await label(x) },
      origin: null, version: null, evidence: [], validFrom: null, validTo: null, decidedAt: null,
    });
  }

  const items = await runner.q<Row>(
    `SELECT l.agenda_item_id, i.title, i.start_date::text AS start_date, l.origin, l.legacy_column, l.version,
            (SELECT count(*)::int FROM business_operation_agenda_links l2
               JOIN business_operations o2 ON o2.id = l2.operation_id AND o2.account_id = l2.account_id AND ${actif('o2')}
              WHERE l2.account_id = $1 AND l2.agenda_item_id = l.agenda_item_id AND l2.state = 'ACTIVE') AS shared_with
       FROM business_operation_agenda_links l
       JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
      WHERE l.account_id = $1 AND l.operation_id = $2 AND l.state = 'ACTIVE'
      ORDER BY i.start_date NULLS LAST, i.id`, [accountId, id]);
  const refus = await runner.q<Row>(
    `SELECT source_entity_key AS k FROM business_operation_match_decisions
      WHERE account_id = $1 AND candidate_operation_id = $2 AND source_kind = 'AGENDA' AND decision = 'REJECTED' AND active
        AND source_entity_key ~ '^[0-9]{1,9}$' ORDER BY id`, [accountId, id]);
  return {
    operationId: id,
    redirectedFrom: resolu.redirectedFrom,
    relations,
    refusedOperationIds: [...new Set(refusedOperationIds)].sort((a, b) => a - b),
    agendaItems: items.map((x) => ({
      agendaItemId: n(x.agenda_item_id), title: String(x.title ?? ''), startDate: (x.start_date as string | null) ?? null,
      origin: x.origin as GraphOrigin, legacyColumn: x.legacy_column === true, sharedWith: n(x.shared_with), version: n(x.version),
    })),
    refusedAgendaItemIds: [...new Set(refus.map((x) => n(x.k)))].sort((a, b) => a - b),
  };
}

export interface AgendaItemOperationView extends GraphOperationRef {
  origin: GraphOrigin;
  legacyColumn: boolean;
}

/**
 * Événements de référence ACTIFS d'UN élément d'Agenda du compte (lecture
 * inverse, N↔N). null : élément introuvable dans ce compte. Liste vide :
 * élément autonome (ce n'est pas une anomalie, CDC §2).
 */
export async function readAgendaItemOperations(accountId: number, agendaItemId: number, runner: GroupingRunner = drizzleRunner(db)): Promise<AgendaItemOperationView[] | null> {
  const [item] = await runner.q<Row>(`SELECT 1 AS ok FROM agenda_items WHERE id = $1 AND account_id = $2`, [agendaItemId, accountId]);
  if (!item) return null;
  const x = await runner.q<Row>(
    `SELECT o.id, o.type_code, o.technical_label, o.provider, l.origin, l.legacy_column
       FROM business_operation_agenda_links l
       JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND ${actif('o')}
      WHERE l.account_id = $1 AND l.agenda_item_id = $2 AND l.state = 'ACTIVE'
      ORDER BY l.legacy_column DESC, o.id`, [accountId, agendaItemId]);
  const out: AgendaItemOperationView[] = [];
  for (const o of x) {
    out.push({ operationId: n(o.id), typeCode: (o.type_code as string | null) ?? null, label: await label(o), origin: o.origin as GraphOrigin, legacyColumn: o.legacy_column === true });
  }
  return out;
}
