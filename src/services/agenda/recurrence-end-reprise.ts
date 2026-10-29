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
 *   · RETIRED : prévision automatique intacte, À VENIR, annulée SANS trace
 *     (aucun « STATUS_CHANGED » de l'utilisateur, aucun « FORECAST_RETIRED »
 *     tracé depuis 99D), dans la fenêtre d'une occurrence attendue ;
 *   · MISSING : occurrence attendue sans aucun élément de la série dans sa
 *     fenêtre (jamais générée).
 *
 * Réparation (déléguée par le contrôle COH-AGENDA-RECURRENCE-END) :
 *   · RETIRED → statut retiré (prévision rétablie), événement tracé
 *     `FORECAST_RESTORED` (retour arrière : reposer « annulé ») ;
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
      SELECT i.id, i.start_date::text AS d, i.occurrence_nature AS nature, i.manual_status AS st,
             i.is_automatic AS auto, i.is_automatic_modified AS modif, i.confirmation_mode AS cm,
             EXISTS (SELECT 1 FROM agenda_occurrence_events e
                      WHERE e.agenda_item_id = i.id AND e.event_type IN ('STATUS_CHANGED', 'FORECAST_RETIRED')) AS trace
        FROM agenda_items i
       WHERE i.account_id = $1 AND i.series_key = $2 AND i.start_date IS NOT NULL
       ORDER BY i.start_date, i.id`, [accountId, sk])).map((r) => ({
      id: Number(r.id), d: String(r.d), nature: String(r.nature), st: (r.st as string | null) ?? null,
      auto: r.auto === true, modif: r.modif === true, cm: (r.cm as string | null) ?? null, trace: r.trace === true,
    }));
    const dansFenetre = (x: { d: string }, d: string) => x.d === d || (fenetre > 0 && jours(x.d, d) <= fenetre);
    const retiredIds = pres
      .filter((x) => x.nature === 'FORECAST' && x.st === 'annule' && x.auto && !x.modif && !x.cm && !x.trace
        && x.d >= today && (!bound || x.d <= bound) && expected.some((d) => dansFenetre(x, d)))
      .map((x) => x.id);
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
  sql: Sql, accountId: number, diag: RecurrenceEndDiagnosis, opts: { correlationId: string },
): Promise<{ restored: number[]; t4JobId: number | null; t4Requested: boolean }> {
  const ids = [...new Set(diag.series.flatMap((s) => s.retiredIds))];
  let restored: number[] = [];
  if (ids.length) {
    // Mêmes gardes que le diagnostic, rejouées ATOMIQUEMENT (l'utilisateur a pu agir entre-temps).
    restored = (await q(sql, `
      UPDATE agenda_items i SET manual_status = NULL, updated_at = now()
       WHERE i.account_id = $1 AND i.id = ANY($2::int[]) AND i.occurrence_nature = 'FORECAST' AND i.manual_status = 'annule'
         AND i.is_automatic AND NOT i.is_automatic_modified AND i.confirmation_mode IS NULL
         AND NOT EXISTS (SELECT 1 FROM agenda_occurrence_events e
                          WHERE e.agenda_item_id = i.id AND e.event_type IN ('STATUS_CHANGED', 'FORECAST_RETIRED'))
       RETURNING i.id`, [accountId, ids])).map((r) => Number(r.id));
    for (const id of restored) {
      const s = diag.series.find((x) => x.retiredIds.includes(id));
      await q(sql, `INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json)
                    VALUES ($1, $2, 'FORECAST_RESTORED', $3::jsonb)`, [id, accountId, JSON.stringify({
        reason: LEGACY_END_REVERSED, sourceFileId: diag.fileId, seriesKey: s?.seriesKey ?? null,
        end: s?.end ?? null, correlationId: opts.correlationId, rollback: "reposer manual_status = 'annule'",
      })]);
    }
  }
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
