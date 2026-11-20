/**
 * Carte Trello #806, volet B §7 (CDC « Opérations / Agenda V2.0 » §14, §19 ;
 * AC43, AC44) — LECTURE de la nature des liens entre un document et une
 * opération, pour la fiche de l'opération et le tiroir du document.
 *
 * LECTURE CALCULÉE, RIEN N'EST ÉCRIT ni matérialisé (la carte le demande :
 * « ne pas imposer une matérialisation de chaque lien dérivé en base ») :
 *   · `sharedWith`       : les AUTRES opérations actives auxquelles un
 *                          justificatif de l'opération appartient aussi ;
 *   · `directEvents`     : les événements de l'opération auxquels un
 *                          justificatif MEMBRE est aussi lié directement ;
 *   · `eventDocuments`   : les documents liés DIRECTEMENT (lien saisi ou lu
 *                          par l'analyse, jamais le lien propagé par l'ensemble)
 *                          à un événement de l'opération, qui ne lui
 *                          appartiennent pas ;
 *   · `relatedDocuments` : les pièces du CONTRAT D'ASSURANCE associé à un
 *                          sinistre (référentiel des Types de document), lues
 *                          par la relation entre opérations — ni copiées, ni
 *                          rattachées, ni comptées dans un montant.
 *
 * Règles de pertinence :
 *   · un document que l'utilisateur a RETIRÉ de cette opération (refus
 *     mémorisé) n'y revient jamais par son lien direct à un événement
 *     (CDC §19, AC44 : « exclusion indirecte persistante ») ;
 *   · un événement PARTAGÉ avec une autre opération n'expose pas ici les
 *     documents qui appartiennent à cette autre opération (CDC §14) ;
 *   · un document supprimé (corbeille) n'est jamais rendu ;
 *   · chaque requête est bornée au compte ; aucune limite silencieuse.
 */
import type postgres from 'postgres';
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import { isInsuranceContractDocumentType } from '@/lib/referential/v2/insurance-contract-document-types';
import {
  DOCUMENT_OPERATION_CANDIDATE_LIMIT, type OperationEventDocument, type OperationRef, type OperationRelatedDocument,
} from '@/lib/reference-events/operation-links';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const idOk = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** Opération ACTIVE (alias SQL) : ni invalidée, ni regroupée. */
const actif = (a: string): string => `${a}.invalidated_at IS NULL AND ${a}.merged_into_operation_id IS NULL`;
/** Lien Document ↔ Agenda DIRECT (alias SQL de `agenda_file_links`) : saisi, lu par l'analyse, ou antérieur aux provenances. */
const lienDirect = (l: string): string => `(cardinality(${l}.provenances) = 0 OR ${l}.provenances && ARRAY['MANUAL_DIRECT', 'AI_DIRECT']::text[])`;

async function libelle(r: Row): Promise<string> {
  const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  return referenceEventLabel({ typeCode: txt(r.type_code), technicalLabel: txt(r.technical_label), provider: txt(r.provider) });
}

export interface OperationDocumentLinks {
  /** Justificatif membre → AUTRES opérations actives qui le portent aussi. */
  sharedWith: Map<number, OperationRef[]>;
  /** Justificatif membre → événements de l'opération auxquels il est aussi lié directement. */
  directEvents: Map<number, Array<{ id: number; title: string }>>;
  eventDocuments: OperationEventDocument[];
  relatedDocuments: OperationRelatedDocument[];
}

const VIDE = (): OperationDocumentLinks => ({ sharedWith: new Map(), directEvents: new Map(), eventDocuments: [], relatedDocuments: [] });

/**
 * Nature des liens documentaires de l'opération ACTIVE `operationId` du
 * compte. `related` : opérations associées lues dans le graphe par l'appelant
 * (la fiche les a déjà) — seules celles qui sont un CONTRAT sont lues, et
 * seulement quand l'opération est un SINISTRE.
 */
export async function readOperationDocumentLinks(
  accountId: number, operationId: number,
  o: { typeCode: string | null; related: ReadonlyArray<{ operationId: number; label: string; typeCode: string | null }> },
): Promise<OperationDocumentLinks> {
  const out = VIDE();
  if (!idOk(accountId) || !idOk(operationId)) return out;
  const sql = await sqlClient();
  const params = [accountId, operationId] as never[];

  const [partages, directs, evenementiels] = (await Promise.all([
    sql.unsafe(
      `SELECT d.file_id, o.id, o.type_code, o.technical_label, o.provider
         FROM business_operation_documents d
         JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND ${actif('o')}
        WHERE d.account_id = $1 AND d.active AND d.operation_id <> $2
          AND EXISTS (SELECT 1 FROM business_operation_documents m
                       WHERE m.account_id = $1 AND m.operation_id = $2 AND m.file_id = d.file_id AND m.active)
        ORDER BY d.file_id, o.id`, params),
    sql.unsafe(
      `SELECT l.asset_file_id AS file_id, i.id, i.title
         FROM business_operation_agenda_links g
         JOIN agenda_items i ON i.id = g.agenda_item_id AND i.account_id = g.account_id
         JOIN agenda_file_links l ON l.agenda_item_id = i.id AND ${lienDirect('l')}
        WHERE g.account_id = $1 AND g.operation_id = $2 AND g.state = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM business_operation_documents m
                       WHERE m.account_id = $1 AND m.operation_id = $2 AND m.file_id = l.asset_file_id AND m.active)
        ORDER BY l.asset_file_id, i.start_date NULLS LAST, i.id`, params),
    sql.unsafe(
      `SELECT f.id AS file_id, to_char(f.document_date, 'YYYY-MM-DD') AS document_date, ${documentTitleColumnsSql('f')},
              i.id AS item_id, i.title AS item_title
         FROM business_operation_agenda_links g
         JOIN agenda_items i ON i.id = g.agenda_item_id AND i.account_id = g.account_id
         JOIN agenda_file_links l ON l.agenda_item_id = i.id AND ${lienDirect('l')}
         JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = $1 AND f.deleted_at IS NULL
        WHERE g.account_id = $1 AND g.operation_id = $2 AND g.state = 'ACTIVE'
          -- pas un justificatif de l'opération (il est déjà listé comme tel)
          AND NOT EXISTS (SELECT 1 FROM business_operation_documents m
                           WHERE m.account_id = $1 AND m.operation_id = $2 AND m.file_id = f.id AND m.active)
          -- retiré de CETTE opération par l'utilisateur : il n'y revient pas par l'événement (AC44)
          AND NOT EXISTS (SELECT 1 FROM business_operation_match_decisions x
                           WHERE x.account_id = $1 AND x.candidate_operation_id = $2 AND x.source_kind = 'DOCUMENT'
                             AND x.source_entity_key = f.id::text AND x.decision = 'REJECTED' AND x.active)
          -- événement partagé : le document d'une AUTRE opération de cet événement reste le sien (CDC §14)
          AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links g2
                            JOIN business_operations o2 ON o2.id = g2.operation_id AND o2.account_id = g2.account_id AND ${actif('o2')}
                            JOIN business_operation_documents d2 ON d2.account_id = g2.account_id AND d2.operation_id = g2.operation_id
                                 AND d2.file_id = f.id AND d2.active
                           WHERE g2.account_id = $1 AND g2.agenda_item_id = i.id AND g2.state = 'ACTIVE' AND g2.operation_id <> $2)
        ORDER BY f.document_date NULLS LAST, f.id, i.start_date NULLS LAST, i.id`, params),
  ])) as unknown as [Row[], Row[], Row[]];

  for (const r of partages) {
    const f = Number(r.file_id);
    out.sharedWith.set(f, [...(out.sharedWith.get(f) ?? []), { operationId: Number(r.id), label: await libelle(r) }]);
  }
  for (const r of directs) {
    const f = Number(r.file_id);
    out.directEvents.set(f, [...(out.directEvents.get(f) ?? []), { id: Number(r.id), title: String(r.title ?? '') }]);
  }
  const parFichier = new Map<number, OperationEventDocument>();
  for (const r of evenementiels) {
    const f = Number(r.file_id);
    const doc = parFichier.get(f) ?? { fileId: f, title: documentTitleOf(r as DocumentTitleColumns), date: day(r.document_date), agendaItems: [] };
    doc.agendaItems.push({ id: Number(r.item_id), title: String(r.item_title ?? '') });
    parFichier.set(f, doc);
  }
  out.eventDocuments = [...parFichier.values()];

  // Sinistre → contrat(s) d'assurance associé(s) : les pièces qui établissent le contrat (référentiel), lues sans copie.
  const contrats = o.typeCode === 'CLAIM' ? o.related.filter((r) => r.typeCode === 'CONTRACT' && idOk(r.operationId)) : [];
  if (contrats.length) {
    const noms = new Map(contrats.map((c) => [c.operationId, c.label]));
    const rows = (await sql.unsafe(
      `SELECT f.id AS file_id, f.document_type_code, to_char(f.document_date, 'YYYY-MM-DD') AS document_date, ${documentTitleColumnsSql('f')}, d.operation_id
         FROM business_operation_documents d
         JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND ${actif('o')} AND o.type_code = 'CONTRACT'
         JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
        WHERE d.account_id = $1 AND d.active AND d.operation_id = ANY($2::bigint[])
        ORDER BY d.operation_id, f.document_date NULLS LAST, f.id`,
      [accountId, `{${[...noms.keys()].join(',')}}`] as never[],
    )) as unknown as Row[];
    const vus = new Set<number>();
    for (const r of rows) {
      const f = Number(r.file_id);
      if (vus.has(f) || !isInsuranceContractDocumentType(txt(r.document_type_code))) continue;
      vus.add(f);
      const op = Number(r.operation_id);
      out.relatedDocuments.push({ fileId: f, title: documentTitleOf(r as DocumentTitleColumns), date: day(r.document_date), operationId: op, operationLabel: noms.get(op) ?? '' });
    }
  }
  return out;
}

// ── Tiroir d'un document ────────────────────────────────────────────────────

export interface DocumentOperationCandidate { id: number; title: string; meta: string | null }
export interface DocumentOperationCandidateList { candidates: DocumentOperationCandidate[]; more: boolean }

const sansAccent = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Borne de lecture des opérations candidates (leur titre est calculé, puis filtré) : au-delà, `more` le dit. */
const SCAN_LIMIT = 500;

/**
 * Opérations ACTIVES du compte auxquelles le document n'appartient PAS encore
 * (choix du geste « Rattacher à une opération »), filtrées par le texte saisi
 * sur leur titre (celui de la fiche). null : document absent du compte.
 */
export async function readDocumentOperationCandidates(accountId: number, fileId: number, query: string): Promise<DocumentOperationCandidateList | null> {
  if (!idOk(accountId) || !idOk(fileId)) return null;
  const sql = await sqlClient();
  const [doc] = (await sql.unsafe(`SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[])) as unknown as Row[];
  if (!doc) return null;
  const { REFERENCE_EVENT_SEARCH_SQL, referenceEventSearchFactsOf } = await import('./reference-event-page');
  // Les sous-requêtes de `REFERENCE_EVENT_SEARCH_SQL` lisent le compte en `$1`.
  const rows = (await sql.unsafe(
    `SELECT o.id, o.type_code, o.technical_label, o.provider,
            ${REFERENCE_EVENT_SEARCH_SQL.presentationFacts},
            ${REFERENCE_EVENT_SEARCH_SQL.assetNames} AS asset_names,
            ${REFERENCE_EVENT_SEARCH_SQL.foundingDeclaration} AS founding_declaration,
            ${REFERENCE_EVENT_SEARCH_SQL.firstDocument} AS first_document
       FROM business_operations o
      WHERE o.account_id = $1 AND ${actif('o')}
        AND NOT EXISTS (SELECT 1 FROM business_operation_documents d
                         WHERE d.account_id = $1 AND d.operation_id = o.id AND d.file_id = $2 AND d.active)
      ORDER BY o.id DESC LIMIT ${SCAN_LIMIT + 1}`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  const mots = sansAccent(query.replace(/\s+/g, ' ').trim().slice(0, 80)).split(' ').filter((m) => m.length > 0);
  const items: DocumentOperationCandidate[] = [];
  for (const r of rows.slice(0, SCAN_LIMIT)) {
    const f = await referenceEventSearchFactsOf(r);
    if (!mots.every((m) => sansAccent(f.title).includes(m))) continue;
    items.push({ id: f.id, title: f.title, meta: f.ownDate ? `${f.ownDate.slice(8, 10)}/${f.ownDate.slice(5, 7)}/${f.ownDate.slice(0, 4)}` : null });
  }
  return {
    candidates: items.slice(0, DOCUMENT_OPERATION_CANDIDATE_LIMIT),
    more: items.length > DOCUMENT_OPERATION_CANDIDATE_LIMIT || rows.length > SCAN_LIMIT,
  };
}

/**
 * Pour chaque opération ACTIVE du document : les événements de l'Agenda de
 * cette opération auxquels le document est AUSSI lié directement. Sert au
 * tiroir du document à ne pas présenter deux fois le même lien.
 */
export async function readDocumentDirectEventsByOperation(accountId: number, fileId: number, runner?: Sql): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!idOk(accountId) || !idOk(fileId)) return out;
  const sql = runner ?? await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT d.operation_id, g.agenda_item_id
       FROM business_operation_documents d
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND ${actif('o')}
       JOIN business_operation_agenda_links g ON g.account_id = d.account_id AND g.operation_id = d.operation_id AND g.state = 'ACTIVE'
       JOIN agenda_file_links l ON l.agenda_item_id = g.agenda_item_id AND l.asset_file_id = d.file_id AND ${lienDirect('l')}
      WHERE d.account_id = $1 AND d.file_id = $2 AND d.active
      ORDER BY d.operation_id, g.agenda_item_id`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  for (const r of rows) {
    const op = Number(r.operation_id);
    out.set(op, [...(out.get(op) ?? []), Number(r.agenda_item_id)]);
  }
  return out;
}
