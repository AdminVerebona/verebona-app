/**
 * Activité par traitement pour le tableau de bord — CDC BO IA HLT-01, PER-01,
 * VOL-01 (lot IA 2).
 *
 * Les cartes du tableau de bord ne montraient que l'état et la file : ni
 * dernière exécution, ni taux de succès, ni volume. Une seule requête sur
 * `ai_usage_event` (appels modèle), bornée à 30 jours, agrégée par
 * traitement : volumes, échecs et taux de succès 24 h / 7 j / 30 j, dernier
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
  /** PER-01 : mêmes taux sur 24 h et 30 j (sélecteur de fenêtre du tableau de bord). */
  successRate24h: number | null;
  successRate30d: number | null;
  /** VOL-01 : appels en échec par fenêtre. */
  failed24h: number;
  failed7d: number;
  failed30d: number;
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
            COUNT(*) FILTER (WHERE created_at > $1::timestamptz - interval '1 day' AND status = 'success')  AS ok24,
            COUNT(*) FILTER (WHERE status = 'success')                                AS ok30,
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
    const c24 = Number(r?.c24 ?? 0);
    const c7 = Number(r?.c7 ?? 0);
    const c30 = Number(r?.c30 ?? 0);
    const ok24 = Number(r?.ok24 ?? 0);
    const ok7 = Number(r?.ok7 ?? 0);
    const ok30 = Number(r?.ok30 ?? 0);
    return {
      treatment: t,
      calls24h: c24,
      calls7d: c7,
      calls30d: c30,
      successRate7d: successRate(ok7, c7),
      successRate24h: successRate(ok24, c24),
      successRate30d: successRate(ok30, c30),
      failed24h: Math.max(0, c24 - ok24),
      failed7d: Math.max(0, c7 - ok7),
      failed30d: Math.max(0, c30 - ok30),
      lastCallAt: r?.last_at ? new Date(String(r.last_at)).toISOString() : null,
      lastErrorAt: r?.last_err ? new Date(String(r.last_err)).toISOString() : null,
    };
  });
}
