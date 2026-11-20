/**
 * Carte #744, travaux D — écriture (CDC « Opérations / Agenda V2.0 » §14,
 * §19) — CANDIDATS proposés par la page d'un événement de référence quand
 * l'utilisateur veut rattacher un événement de l'Agenda, un document, relier
 * un fournisseur, associer un autre événement de référence ou y déplacer un
 * document.
 *
 * LECTURE seule, aucune IA, aucune suggestion « intelligente » : la liste des
 * objets DU COMPTE qui ne sont pas déjà reliés à cet événement de référence,
 * filtrée par le texte saisi (titre ou nom), du plus récent au plus ancien.
 * Bornée au compte dans CHAQUE requête. Jamais de limite silencieuse : `more`
 * dit qu'il existe d'autres résultats (l'écran invite à préciser la recherche).
 * Le choix reste celui de l'utilisateur ; l'écriture passe par la façade
 * `operation-write.facade.ts`, qui relit chaque identifiant dans le compte.
 */
import type postgres from 'postgres';
import { documentTitleJsonSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import {
  REFERENCE_EVENT_CANDIDATE_LIMIT, type ReferenceEventCandidate, type ReferenceEventCandidateKind, type ReferenceEventCandidateList,
} from '@/lib/reference-events/reference-event-write';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Texte saisi → motif `LIKE` (caractères jokers neutralisés) ; null : pas de filtre. */
function likePattern(q: string): string | null {
  const t = q.replace(/\s+/g, ' ').trim().slice(0, 80);
  return t ? `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

const sansAccent = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Borne de lecture des événements de référence candidats (leur titre est calculé, puis filtré). */
const REFERENCE_SCAN_LIMIT = 500;

function jsonObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Candidats de la nature demandée pour l'événement de référence ACTIF
 * `operationId` du compte. null : événement de référence introuvable dans ce
 * compte, invalidé ou regroupé (→ 404).
 */
export async function readReferenceEventCandidates(
  accountId: number, operationId: number, kind: ReferenceEventCandidateKind, query: string,
): Promise<ReferenceEventCandidateList | null> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(operationId) || operationId <= 0) return null;
  const sql = await sqlClient();
  const [op] = (await sql.unsafe(
    `SELECT 1 FROM business_operations WHERE account_id = $1 AND id = $2 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [accountId, operationId] as never[],
  )) as unknown as Row[];
  if (!op) return null;
  const motif = likePattern(query);
  const limite = REFERENCE_EVENT_CANDIDATE_LIMIT;
  const coupe = (items: ReferenceEventCandidate[]): ReferenceEventCandidateList => ({ items: items.slice(0, limite), more: items.length > limite });

  if (kind === 'agenda') {
    const rows = (await sql.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS start_date
         FROM agenda_items i
        WHERE i.account_id = $1
          AND NOT EXISTS (SELECT 1 FROM business_operation_agenda_links l
                           WHERE l.account_id = $1 AND l.operation_id = $2 AND l.agenda_item_id = i.id AND l.state = 'ACTIVE')
          AND ($3::text IS NULL OR i.title ILIKE $3 ESCAPE '\\')
        ORDER BY i.start_date DESC NULLS LAST, i.id DESC LIMIT ${limite + 1}`,
      [accountId, operationId, motif] as never[],
    )) as unknown as Row[];
    return coupe(rows.map((r) => ({ id: Number(r.id), title: String(r.title ?? ''), date: day(r.start_date), typeCode: null })));
  }

  if (kind === 'document') {
    const rows = (await sql.unsafe(
      `SELECT f.id, to_char(f.document_date, 'YYYY-MM-DD') AS document_date, ${documentTitleJsonSql('f')} AS titre
         FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM business_operation_documents d
                           WHERE d.account_id = $1 AND d.operation_id = $2 AND d.file_id = f.id AND d.active)
          AND ($3::text IS NULL OR f.retained_title ILIKE $3 ESCAPE '\\' OR f.web_link_title ILIKE $3 ESCAPE '\\'
               OR f.original_filename ILIKE $3 ESCAPE '\\' OR f.filename ILIKE $3 ESCAPE '\\')
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT ${limite + 1}`,
      [accountId, operationId, motif] as never[],
    )) as unknown as Row[];
    return coupe(rows.map((r) => {
      const t = jsonObject(r.titre);
      return { id: Number(r.id), title: t ? documentTitleOf(t as DocumentTitleColumns) : 'Document', date: day(r.document_date), typeCode: null };
    }));
  }

  if (kind === 'supplier') {
    const rows = (await sql.unsafe(
      `SELECT s.id, s.name
         FROM suppliers s
        WHERE s.account_id = $1 AND s.status <> 'deleted'
          AND NOT EXISTS (SELECT 1 FROM business_operation_suppliers bs
                           WHERE bs.account_id = $1 AND bs.operation_id = $2 AND bs.supplier_id = s.id AND bs.status = 'ACTIVE')
          AND ($3::text IS NULL OR s.name ILIKE $3 ESCAPE '\\')
        ORDER BY s.name, s.id LIMIT ${limite + 1}`,
      [accountId, operationId, motif] as never[],
    )) as unknown as Row[];
    return coupe(rows.map((r) => ({ id: Number(r.id), title: String(r.name ?? ''), date: null, typeCode: null })));
  }

  // Autres opérations ACTIVES du compte, pas encore associées à celle-ci (`reference`). Le titre est celui de la page
  // (règle unique). Carte #806 §1 : la nature `move-target` (cible d'un déplacement de document) est retirée.
  const { REFERENCE_EVENT_SEARCH_SQL, referenceEventSearchFactsOf } = await import('./reference-event-page');
  const rows = (await sql.unsafe(
    `SELECT o.id, o.type_code, o.technical_label, o.provider,
            to_char(o.planned_date, 'YYYY-MM-DD') AS planned_date, to_char(o.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(o.realized_date, 'YYYY-MM-DD') AS realized_date,
            ${REFERENCE_EVENT_SEARCH_SQL.assetNames} AS asset_names,
            ${REFERENCE_EVENT_SEARCH_SQL.foundingDeclaration} AS founding_declaration,
            ${REFERENCE_EVENT_SEARCH_SQL.firstDocument} AS first_document
       FROM business_operations o
      WHERE o.account_id = $1 AND o.id <> $2 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM business_operation_relations r
               WHERE r.account_id = $1 AND r.state = 'ACTIVE'
                 AND ((r.from_operation_id = $2 AND r.to_operation_id = o.id) OR (r.from_operation_id = o.id AND r.to_operation_id = $2)))
      ORDER BY o.id DESC LIMIT ${REFERENCE_SCAN_LIMIT + 1}`,
    [accountId, operationId] as never[],
  )) as unknown as Row[];
  const tronque = rows.length > REFERENCE_SCAN_LIMIT;
  const mots = sansAccent(query).split(/\s+/).filter((m) => m.length > 0);
  const items: ReferenceEventCandidate[] = [];
  for (const r of rows.slice(0, REFERENCE_SCAN_LIMIT)) {
    const f = await referenceEventSearchFactsOf(r);
    const cible = sansAccent(f.title);
    if (!mots.every((m) => cible.includes(m))) continue;
    items.push({ id: f.id, title: f.title, date: f.ownDate, typeCode: f.typeCode });
  }
  const liste = coupe(items);
  return { items: liste.items, more: liste.more || tronque };
}
