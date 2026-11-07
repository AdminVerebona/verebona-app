/**
 * Lot 99D — reprise des séries d'échéances arrêtées À TORT par l'ancienne
 * règle « mot-clé » (`ended = true` dès qu'un extrait contenait
 * « résiliation », « fin du contrat », « dernière échéance »…).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SANS NOUVEL ENVOI DE DOCUMENT, SANS TOUCHER AU PASSÉ RÉEL
 *
 * Diagnostic (LECTURE SEULE, sans IA) d'un document source :
 *   · ses candidats agenda sont RECONSTRUITS depuis ses faits T1 persistés,
 *     par le même constructeur que l'analyse (`lateLinkAgendaCandidates`) —
 *     fin de récurrence qualifiée comprise (`recurrence-end.ts`) ;
 *   · seules les séries dont T4 a ACCEPTÉ la récurrence (occurrence de base
 *     portant une `series_key`) et dont l'extrait porte l'empreinte de
 *     l'ancienne règle (`legacyKeywordEndFlag`) sont examinées ;
 *   · occurrences ATTENDUES = prochaines occurrences À VENIR recalculées
 *     (`computeOccurrences`, jamais après une fin confirmée) ;
 *   · RETIRED : (lot 113P, #715) PLUS AUCUNE — le statut « annulé » n'existe
 *     plus ; la migration 1526 a neutralisé les anciens statuts (les
 *     prévisions annulées à tort par l'ancienne règle sont redevenues
 *     visibles), `retiredIds` est toujours vide ;
 *   · MISSING : occurrence attendue sans aucun élément de la série dans sa
 *     fenêtre (jamais générée) — une occurrence (ou une série) SUPPRIMÉE par
 *     l'utilisateur n'est jamais manquante (lot 113P, trace d'exclusion).
 *
 * Réparation (déléguée par le contrôle COH-AGENDA-RECURRENCE-END) :
 *   · RETIRED → sans objet depuis le lot 113P (aucun statut à retirer) ;
 *   · MISSING → candidats du document remis dans la file T4 existante
 *     (`enqueueT4Candidates`, sans retrait : analyse non déclarée complète) —
 *     T4 redécide, le moteur génère les occurrences. Appels IA limités aux
 *     documents concernés.
 * Jamais : une occurrence CONFIRMÉE (réelle) ou passée, un élément touché par
 * l'utilisateur, une série dont la fin est confirmée et datée (au-delà).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import type { AgendaCandidate } from '@/services/ai/source-analysis/types';
import {
  computeOccurrences, effectiveSeriesBound, occurrenceWindowDays, type RecurrenceEnd,
} from '@/services/ai/agenda/rules/recurrence';
import { legacyKeywordEndFlag } from '@/services/ai/agenda/rules/recurrence-end';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

/** Motif tracé d'un rétablissement (`agenda_occurrence_events.detail_json.reason`). */
export const LEGACY_END_REVERSED = 'LEGACY_KEYWORD_END_REVERSED';

export interface RecurrenceEndSeriesDiagnosis {
  originFieldKey: string;
  seriesKey: string;
  /** Fin qualifiée relue (null : aucune fin — contrat actif ou reconductible). */
  end: RecurrenceEnd | null;
  /** Borne effective de la série (échéancier énoncé ou fin confirmée). */
  bound: string | null;
  expected: string[];
  /** Prévisions annulées sans trace par l'ancienne règle, à rétablir. */
  retiredIds: number[];
  /** Occurrences attendues jamais générées. */
  missing: string[];
}

export interface RecurrenceEndDiagnosis {
  fileId: number;
  assetId: number;
  series: RecurrenceEndSeriesDiagnosis[];
  /** Candidats du document (relance T4 si une occurrence manque). */
  candidates: AgendaCandidate[];
}

const q = async (sql: Sql, text: string, params: unknown[]): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as unknown as Row[];
const jours = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Documents du compte porteurs d'une série acceptée par T4 (préfiltre de lecture). */
export async function documentsWithAcceptedSeries(sql: Sql, accountId: number, extra = '', params: unknown[] = []): Promise<number[]> {
  const r = await q(sql, `
    SELECT DISTINCT i.origin_ref_id AS id FROM agenda_items i
      JOIN asset_files f ON f.id = i.origin_ref_id AND f.account_id = i.account_id AND f.deleted_at IS NULL
     WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL
       AND i.series_key IS NOT NULL AND i.is_automatic AND i.occurrence_nature = 'CONFIRMED' AND i.origin_field_key IS NOT NULL
       ${extra}
     ORDER BY 1`, [accountId, ...params]);
  return r.map((x) => Number(x.id)).filter(Number.isSafeInteger);
}

/** Diagnostic d'un document (lecture seule, sans IA) ; null : rien à examiner. */
export async function diagnoseRecurrenceEnd(sql: Sql, accountId: number, fileId: number, today: string): Promise<RecurrenceEndDiagnosis | null> {
  const bases = await q(sql, `
    SELECT i.id, i.origin_field_key AS fk, i.series_key AS sk, l.asset_id AS asset
      FROM agenda_items i LEFT JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2
       AND i.series_key IS NOT NULL AND i.is_automatic AND i.occurrence_nature = 'CONFIRMED' AND i.origin_field_key IS NOT NULL
     ORDER BY i.id`, [accountId, fileId]);
  const assetId = bases.map((b) => Number(b.asset)).find((x) => Number.isSafeInteger(x) && x > 0);
  if (!bases.length || !assetId) return null;

  const { getDocumentKnowledge, lateLinkAgendaCandidates } = await import('@/services/ai/knowledge/document-knowledge.service');
  const knowledge = await getDocumentKnowledge(accountId, fileId);
  if (!knowledge || knowledge.facts.length === 0) return null;
  const candidates = lateLinkAgendaCandidates({ knowledge, fileId, assetId, allowReassign: false, today });

  const series: RecurrenceEndSeriesDiagnosis[] = [];
  const vues = new Set<string>();
  for (const b of bases) {
    const fk = String(b.fk);
    const sk = String(b.sk);
    if (vues.has(sk)) continue;
    vues.add(sk);
    const c = candidates.find((x) => x.originFieldKey === fk && x.recurrence);
    const spec = c?.recurrence;
    // Empreinte de l'ancienne règle : seul périmètre de la reprise.
    if (!c || !spec || !legacyKeywordEndFlag(spec.excerpt ?? c.excerpt)) continue;
    const bound = effectiveSeriesBound(spec);
    const expected = computeOccurrences(spec, c.date, today).filter((d) => d !== c.date && d >= today);
    const fenetre = occurrenceWindowDays(spec);
    const pres = (await q(sql, `
      SELECT i.id, i.start_date::text AS d
        FROM agenda_items i
       WHERE i.account_id = $1 AND i.series_key = $2 AND i.start_date IS NOT NULL
       ORDER BY i.start_date, i.id`, [accountId, sk])).map((r) => ({
      id: Number(r.id), d: String(r.d),
    }));
    // Lot 113P (#715) : une occurrence SUPPRIMÉE PAR L'UTILISATEUR (trace d'exclusion,
    // `agenda-user-deletion.ts`) n'est jamais « manquante » — ni relance T4, ni recréation.
    const supprimees = (await q(sql, `
      SELECT r.start_date::text AS d, r.reason
        FROM agenda_item_removals r
       WHERE r.account_id = $1 AND r.reason IN ('USER_DELETED', 'USER_DELETED_SERIES')
         AND r.item_snapshot->>'series_key' = $2`, [accountId, sk]));
    if (supprimees.some((r) => r.reason === 'USER_DELETED_SERIES')) continue;
    for (const r of supprimees) if (r.d && r.d !== 'null') pres.push({ id: 0, d: String(r.d) });
    const dansFenetre = (x: { d: string }, d: string) => x.d === d || (fenetre > 0 && jours(x.d, d) <= fenetre);
    // Lot 113P (#715) : plus de statut « annulé » — aucune prévision à rétablir.
    const retiredIds: number[] = [];
    const missing = expected.filter((d) => !pres.some((x) => dansFenetre(x, d)));
    if (retiredIds.length || missing.length) {
      series.push({ originFieldKey: fk, seriesKey: sk, end: spec.end ?? null, bound, expected, retiredIds, missing });
    }
  }
  return { fileId, assetId, series, candidates };
}

/**
 * Réparation d'un diagnostic : prévisions rétablies (tracées), puis relance
 * T4 du document si une occurrence attendue n'a jamais été générée.
 */
export async function repairRecurrenceEnd(
  sql: Sql, accountId: number, diag: RecurrenceEndDiagnosis, _opts: { correlationId: string },
): Promise<{ restored: number[]; t4JobId: number | null; t4Requested: boolean }> {
  // Lot 113P (#715) : plus de prévision « annulée » à rétablir (aucun statut d'événement).
  const restored: number[] = [];
  const manque = diag.series.some((s) => s.missing.length > 0);
  if (!manque) return { restored, t4JobId: null, t4Requested: false };
  const [owner] = await q(sql, `SELECT owner_user_id AS u FROM accounts WHERE id = $1`, [accountId]);
  const { enqueueT4Candidates } = await import('@/services/ai/agenda');
  // TOUS les candidats du document (une relance remplace un travail en attente de la même source) ;
  // analyse non déclarée complète : aucun retrait d'élément existant.
  const t4JobId = await enqueueT4Candidates({
    accountId, userId: Number(owner?.u), assetId: diag.assetId, leadSourceId: diag.fileId, candidates: diag.candidates,
  });
  return { restored, t4JobId, t4Requested: true };
}
