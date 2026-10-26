/**
 * Lot 72 — ticket « [P1] À traiter — Corriger les écarts résiduels »,
 * §3 « cohérence des décisions entre « À traiter » et T6 » (ATP-FIX-17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE OBLIGATION RÉGLÉE OU ÉCARTÉE DANS « À TRAITER » NE REVIENT PAS PAR T6
 *
 * Source unique, lue par la collecte de la mascotte (T6), des échéances
 * d'agenda issues d'un document dont l'obligation est RÉGLÉE ou ÉCARTÉE par
 * le moteur « À traiter » :
 *   · USER_DONE / USER_NOT_NEEDED / USER_NOT_APPLICABLE — l'utilisateur a
 *     répondu sur la carte d'intervention (« C'est fait », « Pas
 *     nécessaire », « Non applicable ») et aucune carte d'intervention n'est
 *     rouverte : vaut quelle que soit la date de l'échéance (passée ou à
 *     venir) — c'est la même obligation ;
 *   · NO_ACTION — la dernière décision de PERTINENCE sur la donnée de
 *     l'échéance conclut « aucune intervention » (preuve : T4 ou fin
 *     effective lue, jamais l'âge seul — C2), ou l'utilisateur a déclaré la
 *     donnée « Non applicable » : échéances PASSÉES seulement (une échéance
 *     à venir garde son rappel). Une trace de simple constat (donnée déjà
 *     connue) n'est jamais lue comme un règlement.
 * La clé de la donnée est rapprochée par le registre canonique (alias de
 * `origin_field_key` compris) — l'ancienne lecture ne comparait que la clé
 * brute et ignorait les issues lot 61 autres que NO_ACTION_NEEDED.
 * Lecture seule, isolée par compte, bornée. Tables absentes : aucune.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { getField } from '@/services/canonical/registry';
import { documentBridgeRules } from './rules-catalog';
import { isDeadlineRule } from './document-field-evidence';

type SettledReason = 'USER_DONE' | 'USER_NOT_NEEDED' | 'USER_NOT_APPLICABLE' | 'NO_ACTION';

interface SettledObligation {
  agendaItemId: number;
  fileId: number;
  dataKey: string;
  reason: SettledReason;
  /** Date de la décision (ISO). */
  decidedAt: string | null;
  /** L'échéance est-elle à venir ? */
  future: boolean;
}

/** Correspondance clé lue (alias) → clé d'échéance du pont (registre). Pure. */
function deadlineKeyAliases(): Array<{ alias: string; key: string }> {
  const out: Array<{ alias: string; key: string }> = [];
  for (const r of documentBridgeRules().filter(isDeadlineRule)) {
    const key = r.fieldKey!;
    for (const a of new Set([key, ...(getField(key)?.aliases ?? [])])) out.push({ alias: a, key });
  }
  return out;
}

const LIMITE = 500;

/**
 * Obligations réglées / écartées des échéances documentaires d'un compte
 * (`today` : AAAA-MM-JJ, Europe/Paris).
 */
export async function settledObligations(accountId: number, today: string, limit = LIMITE): Promise<SettledObligation[]> {
  const [t] = (await pgClient.unsafe(`SELECT to_regclass('document_rule_evaluations') IS NOT NULL AS ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
               AND table_name = 'document_rule_evaluations' AND column_name = 'outcome') AS l61`)) as unknown as Array<{ ok: boolean; l61: boolean }>;
  const map = deadlineKeyAliases();
  const rows = (await pgClient.unsafe(
    `WITH cles AS (SELECT * FROM unnest($3::text[], $4::text[]) AS c(alias, cle)),
     items AS (
       SELECT i.id, i.origin_ref_id AS file_id, COALESCE(c.cle, i.origin_field_key) AS cle, i.start_date < $2::date AS passe
         FROM agenda_items i LEFT JOIN cles c ON c.alias = i.origin_field_key
        WHERE i.account_id = $1 AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL AND i.origin_field_key IS NOT NULL
          AND i.start_date IS NOT NULL
     )
     SELECT it.id, it.file_id, it.cle, it.passe,
            iv.reason AS iv_reason, iv.choice AS iv_choice, iv.at AS iv_at,
            ${t?.ok ? `ev.outcome AS ev_outcome, ev.pertinence AS ev_pertinence, ev.at AS ev_at` : `NULL::text AS ev_outcome, NULL::text AS ev_pertinence, NULL::timestamptz AS ev_at`}
       FROM items it
       LEFT JOIN LATERAL (
         SELECT a.resolution_reason AS reason, a.resolved_at AS at,
                (SELECT e.details ->> 'choice' FROM to_process_action_events e WHERE e.action_id = a.id AND e.account_id = a.account_id ORDER BY e.id DESC LIMIT 1) AS choice
           FROM to_process_actions a
          WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.target_id = it.file_id AND a.field_key = 'intervention:' || it.cle
            AND a.resolved_at IS NOT NULL AND a.resolution_reason IN ('USER_ARBITRATED', 'NOT_APPLICABLE')
            AND NOT EXISTS (SELECT 1 FROM to_process_actions b WHERE b.account_id = $1 AND b.target_type = 'DOCUMENT' AND b.target_id = it.file_id
                              AND b.field_key = 'intervention:' || it.cle AND b.resolved_at IS NULL)
          ORDER BY a.resolved_at DESC LIMIT 1) iv ON true
       ${t?.ok ? `LEFT JOIN LATERAL (
         SELECT ${t.l61 ? 'x.outcome' : 'NULL::text AS outcome'}, x.pertinence, x.reason_code, x.last_seen_at AS at FROM document_rule_evaluations x
          WHERE x.account_id = $1 AND x.file_id = it.file_id AND x.field_key = it.cle
            AND (x.pertinence IS NOT NULL OR x.reason_code = 'USER_NOT_APPLICABLE_UNCHANGED')
          ORDER BY x.id DESC LIMIT 1) ev ON true` : ''}
      WHERE iv.reason IS NOT NULL
         ${t?.ok ? `OR (it.passe AND (ev.pertinence IN ('NO_ACTION_NEEDED', 'CONTRACT_TERMINATED') OR ev.reason_code = 'USER_NOT_APPLICABLE_UNCHANGED'))` : ''}
      ORDER BY it.id LIMIT $5`,
    [accountId, today, map.map((m) => m.alias), map.map((m) => m.key), Math.max(1, Math.min(LIMITE, limit))] as never[],
  )) as unknown as Array<{ id: number; file_id: number; cle: string; passe: boolean; iv_reason: string | null; iv_choice: string | null; iv_at: string | null;
    ev_outcome: string | null; ev_pertinence: string | null; ev_at: string | null }>;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return rows.map((r) => {
    const parUtilisateur = r.iv_reason !== null;
    const reason: SettledReason = !parUtilisateur ? 'NO_ACTION'
      : r.iv_reason === 'NOT_APPLICABLE' ? 'USER_NOT_APPLICABLE' : r.iv_choice === 'NOT_NEEDED' ? 'USER_NOT_NEEDED' : 'USER_DONE';
    return {
      agendaItemId: Number(r.id), fileId: Number(r.file_id), dataKey: r.cle, reason,
      decidedAt: iso(parUtilisateur ? r.iv_at : r.ev_at), future: !r.passe,
    };
  });
}

/** Identifiants seuls (collecte de la mascotte, `MascotRawData.toProcessSettledAgendaIds`). */
export async function toProcessSettledAgendaIds(accountId: number, today: string, limit = LIMITE): Promise<number[]> {
  return (await settledObligations(accountId, today, limit)).map((o) => o.agendaItemId);
}
