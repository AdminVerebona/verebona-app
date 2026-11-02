/**
 * Statut d'un FAIT HISTORIQUE de l'agenda à partir des preuves — lot 103D
 * (ticket « Agenda — statut et rappels », cas « Contrôle réalisé — Maison »
 * du 22/12/2020, CA01 à CA03, CA08).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE ÉTABLIE (par le code)
 *
 *   1. AFFICHAGE : le sélecteur « Statut » du tiroir portait, pour « aucun
 *      statut manuel », le libellé FIXE « À venir » — quel que soit l'état
 *      calculé (le badge voisin disait « Statut à confirmer »). Corrigé :
 *      `automaticStatusOptionLabel` (lib/agenda/effective-status).
 *   2. DONNÉES : un fait HISTORICAL passé n'est JAMAIS réconcilié avec ses
 *      preuves — `reconcileAgendaStatusForSource` (agenda-status-sync) écarte
 *      explicitement les éléments HISTORICAL (`loadOpenItems`) — il reste
 *      « Statut à confirmer » même quand le document lié, daté du jour du
 *      fait et d'un type qui en établit la réalisation, le prouve.
 *
 * RÈGLE (pure, `historicalCompletionVerdict`)
 *
 *   · seulement un élément HISTORICAL, daté, passé, SANS statut, automatique
 *     et jamais modifié par l'utilisateur (statut changé, élément modifié ou
 *     confirmé : PROTÉGÉ, jamais réécrit) ;
 *   · « Réalisé » seulement sur PREUVE FIABLE : un document LIÉ à l'élément,
 *     non supprimé, DATÉ du jour du fait (tolérance
 *     `HISTORICAL_PROOF_DATE_TOLERANCE_DAYS`), dont le type documentaire
 *     établit la réalisation de ce type d'événement (`completionProofs` du
 *     DOCUMENT_CATALOG, `establishes: 'completed'`). L'intitulé de l'élément
 *     ou du document n'est JAMAIS une preuve ; la seule date dépassée non
 *     plus ;
 *   · sinon : l'état reste « Statut à confirmer » (passé, réalisation
 *     inconnue), le champ incertain est nommé (`uncertainField`) ; aucun
 *     statut, aucune date, aucun événement inventé ;
 *   · la qualification de catégorie (« Donnée à qualifier ») d'un fait
 *     historique prouvé est levée — un fait passé est toujours une
 *     information (D-14) — SAUF si un conflit de données est en attente
 *     (arbitrage de l'utilisateur, jamais tranché ici).
 *
 * REPRÉSENTATION (migration 0945) : la preuve est MÉMORISÉE sur l'élément
 * (`completion_proof_file_id`, `completion_proven_at`) et le statut « Réalisé »
 * est CALCULÉ à la lecture (`computeEffectiveStatus`, `completionProven`) —
 * jamais un statut manuel posé : l'élément reste automatique et intact (T4 peut
 * encore le mettre à jour ; la consolidation 76H peut encore fusionner deux
 * représentations de la même occurrence ; un statut posé par l'utilisateur
 * prime). Document supprimé : la preuve tombe, l'état redevient « à confirmer ».
 *
 * Appliquée par le contrôle de cohérence COH-AGENDA-HISTORICAL-STATUS
 * (rattrapage du stock, contrôle ciblé à chaque analyse), idempotente et
 * tracée (`agenda_occurrence_events` COMPLETION_PROVEN, avant / après).
 * La récurrence éventuelle (échéance suivante) reste celle de T4 (#267) :
 * rien n'est généré ici, le fait de 2020 n'est jamais transformé en échéance.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { resolveDocumentType } from '@/services/canonical/registry';
import { agendaDatePassed, historicalSql } from './agenda-historical';
import { resolveEventSemantics } from './agenda-functional-key';

type Sql = postgres.Sql;

/** Écart maximal (jours) entre la date du document et celle du fait. Défaut prudent : le même jour. */
export const HISTORICAL_PROOF_DATE_TOLERANCE_DAYS = 0;

/** Événements qui prouvent un geste de l'utilisateur sur l'élément (protection). */
export const USER_TOUCH_EVENT_TYPES: readonly string[] = ['STATUS_CHANGED', 'USER_MODIFIED', 'USER_CONFIRMED'];

export interface HistoricalItemFacts {
  id: number;
  startDate: string | null;
  endDate?: string | null;
  manualStatus: string | null;
  historical: boolean;
  businessType: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  /** Un geste de l'utilisateur sur le statut ou l'élément est tracé. */
  userTouched: boolean;
  requiresQualification: boolean;
  /** Conflit de données en attente d'arbitrage (jamais tranché ici). */
  pendingConflict: boolean;
}

export interface LinkedDocumentFacts {
  fileId: number;
  documentDate: string | null;
  documentTypeCode: string | null;
}

export type HistoricalCompletionVerdict =
  | { kind: 'NOT_APPLICABLE'; reason: 'NOT_HISTORICAL' | 'HAS_STATUS' | 'UNDATED' | 'NOT_PAST' }
  | { kind: 'PROTECTED'; reason: 'MANUAL_ITEM' | 'USER_MODIFIED' }
  | { kind: 'PROVEN'; fileId: number; documentTypeCode: string; proofCode: string; documentDate: string; clearQualification: boolean }
  | {
    kind: 'UNKNOWN';
    /** Champ resté incertain (affiché dans le diagnostic). */
    uncertainField: 'completion';
    reason: 'NO_BUSINESS_TYPE' | 'NO_LINKED_DOCUMENT' | 'NO_DATED_DOCUMENT' | 'DATE_MISMATCH' | 'TYPE_NOT_PROBATIVE';
  };

const jours = (a: string, b: string) => Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000;

/** Preuve de réalisation établie par le TYPE du document pour ce type d'événement (code de preuve), sinon null. */
export function completionProofCode(documentTypeCode: string | null, businessType: string): string | null {
  const entry = resolveDocumentType(documentTypeCode);
  if (!entry || !(entry.businessTypes as readonly string[]).includes(businessType)) return null;
  const proof = (entry.completionProofs ?? []).find((p) => p.establishes === 'completed'
    && (((p as { businessTypes?: readonly string[] }).businessTypes ?? entry.businessTypes) as readonly string[]).includes(businessType));
  return proof?.code ?? null;
}

/** Verdict (pur) — voir l'en-tête. */
export function historicalCompletionVerdict(item: HistoricalItemFacts, docs: readonly LinkedDocumentFacts[], now: Date = new Date()): HistoricalCompletionVerdict {
  if (!item.historical) return { kind: 'NOT_APPLICABLE', reason: 'NOT_HISTORICAL' };
  if (item.manualStatus && item.manualStatus.trim() !== '') return { kind: 'NOT_APPLICABLE', reason: 'HAS_STATUS' };
  const date = item.endDate ?? item.startDate;
  if (!date) return { kind: 'NOT_APPLICABLE', reason: 'UNDATED' };
  if (agendaDatePassed({ startDate: item.startDate, endDate: item.endDate ?? null }, now) !== true) return { kind: 'NOT_APPLICABLE', reason: 'NOT_PAST' };
  if (!item.isAutomatic) return { kind: 'PROTECTED', reason: 'MANUAL_ITEM' };
  if (item.isAutomaticModified || item.userTouched) return { kind: 'PROTECTED', reason: 'USER_MODIFIED' };
  if (!item.businessType) return { kind: 'UNKNOWN', uncertainField: 'completion', reason: 'NO_BUSINESS_TYPE' };
  if (!docs.length) return { kind: 'UNKNOWN', uncertainField: 'completion', reason: 'NO_LINKED_DOCUMENT' };
  const dates = docs.filter((d) => !!d.documentDate);
  if (!dates.length) return { kind: 'UNKNOWN', uncertainField: 'completion', reason: 'NO_DATED_DOCUMENT' };
  let typeProbant = false;
  for (const d of [...dates].sort((a, b) => a.fileId - b.fileId)) {
    const code = completionProofCode(d.documentTypeCode, item.businessType);
    if (!code) continue;
    typeProbant = true;
    if (jours(d.documentDate!, item.startDate ?? date) <= HISTORICAL_PROOF_DATE_TOLERANCE_DAYS) {
      return {
        kind: 'PROVEN', fileId: d.fileId, documentTypeCode: d.documentTypeCode!, proofCode: code, documentDate: d.documentDate!.slice(0, 10),
        clearQualification: item.requiresQualification && !item.pendingConflict,
      };
    }
  }
  return { kind: 'UNKNOWN', uncertainField: 'completion', reason: typeProbant ? 'DATE_MISMATCH' : 'TYPE_NOT_PROBATIVE' };
}

// ── Lectures et réparation (contrôle de cohérence) ──────────────────────────

type Row = Record<string, unknown>;
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Faits historiques candidats du compte (passés, sans statut, automatiques,
 * réalisation pas encore prouvée) — identifiants croissants après `afterId`.
 * `extra` : filtre SQL additionnel (paramètres à partir de `$3`). Colonnes
 * 0945 absentes : aucun candidat (rien ne pourrait être mémorisé).
 */
export async function historicalCandidates(sql: Sql, accountId: number, extra = 'AND i.id > $2', params: unknown[] = [0], limit = 500): Promise<number[]> {
  const { agendaCompletionColumnsReady } = await import('./agenda-columns');
  if (!(await agendaCompletionColumnsReady())) return [];
  const r = await sql.unsafe<Row[]>(
    `SELECT i.id FROM agenda_items i
      WHERE i.account_id = $1 AND (i.manual_status IS NULL OR trim(i.manual_status) = '') AND i.is_automatic
        AND i.start_date IS NOT NULL AND i.start_date < CURRENT_DATE AND ${historicalSql('i')}
        AND i.completion_proof_file_id IS NULL
        ${extra}
      ORDER BY i.id LIMIT ${Math.max(1, Math.min(limit, 5000))}`, [accountId, ...params] as never[]);
  return r.map((x) => Number(x.id));
}

export interface HistoricalDiagnosis {
  itemId: number;
  verdict: HistoricalCompletionVerdict;
  before: { manualStatus: string | null; requiresQualification: boolean };
}

/** Diagnostic (lecture seule) d'un élément du compte ; null : élément absent. */
export async function diagnoseHistoricalStatus(sql: Sql, accountId: number, itemId: number, now: Date = new Date()): Promise<HistoricalDiagnosis | null> {
  const [i] = await sql.unsafe<Row[]>(
    `SELECT i.id, i.start_date::text AS start_date, i.end_date::text AS end_date, i.manual_status, i.is_automatic, i.is_automatic_modified,
            i.requires_qualification, i.business_type, i.origin_field_key, ${historicalSql('i')} AS historical,
            EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = ANY($3::text[])) AS user_touched,
            EXISTS (SELECT 1 FROM agenda_data_conflicts c WHERE c.agenda_item_id = i.id AND c.current_decision = 'pending') AS pending_conflict
       FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2`, [itemId, accountId, [...USER_TOUCH_EVENT_TYPES]] as never[]);
  if (!i) return null;
  const docs = await sql.unsafe<Row[]>(
    `SELECT f.id, f.document_date::text AS document_date, COALESCE(f.document_type_code, f.document_type) AS type_code
       FROM agenda_file_links l JOIN asset_files f ON f.id = l.asset_file_id AND f.account_id = $2 AND f.deleted_at IS NULL
      WHERE l.agenda_item_id = $1 ORDER BY f.id`, [itemId, accountId] as never[]);
  const businessType = (i.business_type as string | null) ?? resolveEventSemantics({ originFieldKey: (i.origin_field_key as string | null) ?? null }).businessType ?? null;
  const facts: HistoricalItemFacts = {
    id: Number(i.id), startDate: day(i.start_date), endDate: day(i.end_date), manualStatus: (i.manual_status as string | null) ?? null,
    historical: i.historical === true, businessType, isAutomatic: i.is_automatic === true, isAutomaticModified: i.is_automatic_modified === true,
    userTouched: i.user_touched === true, requiresQualification: i.requires_qualification === true, pendingConflict: i.pending_conflict === true,
  };
  return {
    itemId: facts.id,
    verdict: historicalCompletionVerdict(facts, docs.map((d) => ({ fileId: Number(d.id), documentDate: day(d.document_date), documentTypeCode: (d.type_code as string | null) ?? null })), now),
    before: { manualStatus: facts.manualStatus, requiresQualification: facts.requiresQualification },
  };
}

/**
 * Réparation d'un fait historique PROUVÉ : preuve MÉMORISÉE (0945) — le statut
 * « Réalisé » est calculé à la lecture, aucun statut manuel n'est posé.
 * Écriture GARDÉE dans la requête : élément encore automatique, intact, sans
 * statut ni preuve (une correction concurrente de l'utilisateur gagne) ;
 * qualification levée si justifié ; trace avant / après. Idempotente.
 */
export async function repairHistoricalStatus(
  sql: Sql, d: HistoricalDiagnosis & { verdict: Extract<HistoricalCompletionVerdict, { kind: 'PROVEN' }> }, accountId: number, opts: { correlationId: string },
): Promise<{ applied: boolean; protected?: boolean }> {
  const applied = await sql.begin(async (tx) => {
    const r = await tx.unsafe<Row[]>(
      `UPDATE agenda_items i SET completion_proof_file_id = $3, completion_proven_at = now(),
              requires_qualification = CASE WHEN $4::boolean THEN false ELSE i.requires_qualification END, updated_at = now()
        WHERE i.id = $1 AND i.account_id = $2 AND i.is_automatic AND NOT COALESCE(i.is_automatic_modified, false)
          AND (i.manual_status IS NULL OR trim(i.manual_status) = '') AND i.completion_proof_file_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = ANY($5::text[]))
          AND EXISTS (SELECT 1 FROM asset_files f JOIN agenda_file_links l ON l.asset_file_id = f.id AND l.agenda_item_id = i.id
                       WHERE f.id = $3 AND f.account_id = $2 AND f.deleted_at IS NULL)
        RETURNING i.id`,
      [d.itemId, accountId, d.verdict.fileId, d.verdict.clearQualification, [...USER_TOUCH_EVENT_TYPES]] as never[]);
    if (!r.length) return false;
    await tx.unsafe(
      `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json) VALUES ($1, $2, 'COMPLETION_PROVEN', $3::text::jsonb)`,
      [d.itemId, accountId, JSON.stringify({
        origin: 'COHERENCE', reasonCode: 'HISTORICAL_COMPLETION_PROVEN', correlationId: opts.correlationId,
        proof: { fileId: d.verdict.fileId, documentTypeCode: d.verdict.documentTypeCode, proofCode: d.verdict.proofCode, documentDate: d.verdict.documentDate },
        before: { ...d.before, effectiveStatus: 'a_confirmer' },
        after: { effectiveStatus: 'realise', manualStatus: d.before.manualStatus, requiresQualification: d.verdict.clearQualification ? false : d.before.requiresQualification },
      })] as never[]);
    return true;
  });
  if (!applied) return { applied: false, protected: true };
  try {
    const { closeAgendaStatusCards } = await import('@/services/to-process/agenda-status-cards');
    await closeAgendaStatusCards(accountId, d.itemId, 'OBSOLETE');
  } catch (e) {
    console.error(`[agenda] cartes de statut de l'élément ${d.itemId} :`, (e as Error).message);
  }
  return { applied: true };
}
