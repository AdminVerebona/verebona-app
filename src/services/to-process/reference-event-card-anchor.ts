/**
 * LECTURES PARTAGÉES DES CARTES « À traiter » QUI PORTENT SUR DES ÉVÉNEMENTS
 * DE RÉFÉRENCE (carte Trello #744, CDC « Opérations / Agenda V2.0 » §8 ; AC16).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE RÈGLE, TROIS CARTES
 *
 * Trois cartes posent des questions différentes sur les mêmes objets :
 *   · `operation-relation-cards.ts`    associer, ou non, deux événements ;
 *   · `operation-agenda-link-cards.ts` rattacher, ou non, un événement de
 *                                      l'Agenda à un second événement ;
 *   · `operation-merge-cards.ts`       même événement, ou deux ? quel fait ?
 *
 * Elles ont besoin des MÊMES lectures : le titre affiché d'un événement de
 * référence (règle unique de la page et de la recherche), le titre d'un
 * justificatif vivant, l'objet RÉEL qui porte la carte, et le filtre
 * d'ISOLATION des preuves citées par une inférence. Ces lectures vivent ici,
 * une fois (une carte ne redéfinit jamais sa propre variante).
 *
 * RÈGLES
 *   · LECTURE SEULE : aucune écriture, aucun objet créé (AC16 : « sans
 *     documents fictifs »), aucun appel IA.
 *   · ISOLATION : chaque requête est filtrée par le compte. Un identifiant
 *     rendu par une inférence ne vaut pas autorisation : hors du compte, ce
 *     n'est pas une preuve, et ce n'est pas un objet qui peut porter la carte.
 *   · Le repli sur un événement de l'Agenda est lu dans le GRAPHE N↔N
 *     (`business_operation_agenda_links`) : jamais le rôle « principal »,
 *     jamais la colonne historique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import type { GraphEvidence } from '@/services/business-operations/graph/model';

type Row = Record<string, unknown>;

/** Tableau d'entiers pour une requête bornée (valeurs non entières écartées). */
export const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x) && x > 0).join(',')}}`;

/** Identifiant d'une preuve utilisable comme entier (une référence libre n'en est pas une). */
export const evidenceIds = (evidence: readonly GraphEvidence[], kind: GraphEvidence['kind']): number[] =>
  evidence.filter((e) => e.kind === kind && /^\d{1,10}$/.test(e.ref)).map((e) => Number(e.ref));

/** Titres des événements de référence ACTIFS du compte (règle unique de la page et de la recherche). */
export async function referenceEventTitles(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const { REFERENCE_EVENT_SEARCH_SQL, referenceEventSearchFactsOf } = await import('@/services/business-operations/graph/reference-event-page');
  const rows = (await pgClient.unsafe(
    `SELECT o.id, o.type_code, o.technical_label, o.provider,
            to_char(o.planned_date, 'YYYY-MM-DD') AS planned_date, to_char(o.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(o.realized_date, 'YYYY-MM-DD') AS realized_date,
            ${REFERENCE_EVENT_SEARCH_SQL.assetNames} AS asset_names,
            ${REFERENCE_EVENT_SEARCH_SQL.supplierNames} AS supplier_names,
            ${REFERENCE_EVENT_SEARCH_SQL.declarations} AS declarations,
            ${REFERENCE_EVENT_SEARCH_SQL.foundingDeclaration} AS founding_declaration,
            ${REFERENCE_EVENT_SEARCH_SQL.references} AS reference_values,
            ${REFERENCE_EVENT_SEARCH_SQL.firstDocument} AS first_document
       FROM business_operations o
      WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`,
    [accountId, intArray(ids)] as never[],
  )) as unknown as Row[];
  for (const r of rows) {
    const f = await referenceEventSearchFactsOf(r);
    out.set(f.id, f.title);
  }
  return out;
}

/** Documents VIVANTS du compte parmi `ids` → titre (règle unique des vues). */
export async function liveDocuments(accountId: number, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const r = (await pgClient.unsafe(
    `SELECT f.id, ${documentTitleColumnsSql('f')} FROM asset_files f
      WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND f.deleted_at IS NULL ORDER BY f.id`,
    [accountId, intArray(ids)] as never[],
  )) as unknown as Array<{ id: number } & DocumentTitleColumns>;
  for (const x of r) out.set(Number(x.id), documentTitleOf(x));
  return out;
}

/**
 * Événement de l'Agenda du compte rattaché à l'un des événements de référence
 * donnés, lu dans le GRAPHE N↔N (carte #744 : aucun rôle « principal », jamais
 * la colonne historique). `itemId` donné : vérifie que CET événement est
 * toujours rattaché (null sinon). `itemId` nul : rend le plus petit
 * identifiant rattaché, ou null.
 */
export async function agendaItemOfOperations(accountId: number, operationIds: readonly number[], itemId: number | null): Promise<number | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT i.id FROM business_operation_agenda_links l
       JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
      WHERE l.account_id = $1 AND l.state = 'ACTIVE' AND l.operation_id = ANY($2::bigint[])
        AND ($3::int IS NULL OR i.id = $3::int)
      ORDER BY i.id LIMIT 1`,
    [accountId, intArray(operationIds), itemId] as never[],
  )) as unknown as Row[];
  return r ? Number(r.id) : null;
}

/**
 * Preuves du COMPTE seulement : documents vivants et événements de l'Agenda du
 * compte ; les autres natures (déclaration, champ structuré) sont gardées
 * telles quelles. Un identifiant rendu par une inférence ne vaut pas
 * autorisation : hors du compte, ce n'est ni présenté ni conservé.
 */
export async function evidenceOfAccount(accountId: number, evidence: readonly GraphEvidence[]): Promise<GraphEvidence[]> {
  const documents = await liveDocuments(accountId, evidenceIds(evidence, 'DOCUMENT'));
  const elements = new Set<number>();
  const agenda = evidenceIds(evidence, 'AGENDA');
  if (agenda.length) {
    const r = (await pgClient.unsafe(
      `SELECT id FROM agenda_items WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, intArray(agenda)] as never[],
    )) as unknown as Row[];
    for (const x of r) elements.add(Number(x.id));
  }
  return evidence.filter((e) => {
    if (e.kind === 'DOCUMENT') return documents.has(Number(e.ref));
    if (e.kind === 'AGENDA') return elements.has(Number(e.ref));
    return true;
  });
}

/** Premier justificatif ACTIF de l'un des événements de référence du compte (fichier vivant), ou null. */
export async function firstDocumentOfOperations(accountId: number, operationIds: readonly number[]): Promise<number | null> {
  const [d] = (await pgClient.unsafe(
    `SELECT bd.file_id FROM business_operation_documents bd
       JOIN asset_files f ON f.id = bd.file_id AND f.account_id = bd.account_id AND f.deleted_at IS NULL
      WHERE bd.account_id = $1 AND bd.operation_id = ANY($2::bigint[]) AND bd.active
      ORDER BY bd.file_id LIMIT 1`,
    [accountId, intArray(operationIds)] as never[],
  )) as unknown as Row[];
  return d ? Number(d.file_id) : null;
}
