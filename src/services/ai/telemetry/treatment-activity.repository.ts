/**
 * Activité par traitement pour le tableau de bord — CDC BO IA HLT-01, PER-01,
 * VOL-01 (lot IA 2).
 *
 * Les cartes du tableau de bord ne montraient que l'état et la file : ni
 * dernière exécution, ni taux de succès, ni volume. Une seule requête sur
 * `ai_usage_event` (appels modèle), bornée à 30 jours, agrégée par
 * traitement : volumes 24 h / 7 j / 30 j, taux de succès sur 7 j, dernier
 * appel et dernier échec.
 *
 * Les appels en mode observation (`metadata.shadow`) sont exclus : ils ne
 * servent aucun utilisateur. Les requêtes T2 tranchées sans IA n'ont pas
 * d'appel modèle : elles figurent dans l'onglet « Requêtes T2 » (SCR-07).
 */
import { pgClient } from '@/db';
import { TREATMENTS, type Treatment } from '../config/treatments';
import { treatmentCaseSql } from '../alerts/cost-evaluator';

export interface TreatmentActivity {
  treatment: Treatment;
  calls24h: number;
  calls7d: number;
  calls30d: number;
  /** Part des appels réussis sur 7 jours, `null` sans appel. */
  successRate7d: number | null;
  lastCallAt: string | null;
  lastErrorAt: string | null;
}

type Row = Record<string, unknown>;

/** Taux de succès (pur) : `null` sans appel, jamais une division par zéro. */
export function successRate(ok: number, total: number): number | null {
  return total > 0 ? Math.round((ok / total) * 1000) / 1000 : null;
}

export async function getTreatmentActivity(now: Date = new Date()): Promise<TreatmentActivity[]> {
  const rows = (await pgClient.unsafe(
    `SELECT t,
            COUNT(*) FILTER (WHERE created_at > $1::timestamptz - interval '1 day')  AS c24,
            COUNT(*) FILTER (WHERE created_at > $1::timestamptz - interval '7 days') AS c7,
            COUNT(*)                                                                AS c30,
            COUNT(*) FILTER (WHERE created_at > $1::timestamptz - interval '7 days' AND status = 'success') AS ok7,
            MAX(created_at)                                                          AS last_at,
            MAX(created_at) FILTER (WHERE status <> 'success')                       AS last_err
       FROM (SELECT ${treatmentCaseSql('e')} AS t, e.created_at, e.status
               FROM ai_usage_event e
              WHERE e.created_at > $1::timestamptz - interval '30 days'
                AND COALESCE((e.metadata ->> 'shadow')::boolean, FALSE) = FALSE) x
      WHERE t IS NOT NULL
      GROUP BY t`,
    [now.toISOString()] as never[],
  )) as unknown as Row[];
  const byT = new Map(rows.map((r) => [String(r.t), r]));
  return TREATMENTS.map((t) => {
    const r = byT.get(t);
    const c7 = Number(r?.c7 ?? 0);
    return {
      treatment: t,
      calls24h: Number(r?.c24 ?? 0),
      calls7d: c7,
      calls30d: Number(r?.c30 ?? 0),
      successRate7d: successRate(Number(r?.ok7 ?? 0), c7),
      lastCallAt: r?.last_at ? new Date(String(r.last_at)).toISOString() : null,
      lastErrorAt: r?.last_err ? new Date(String(r.last_err)).toISOString() : null,
    };
  });
}
