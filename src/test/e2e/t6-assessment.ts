/**
 * Lot 60 — harnais E2E : évaluation IA d'interpellation (R13) déjà faite
 * pour une échéance, comme après un passage T6 réussi. Les scénarios dont la
 * décision d'interpellation n'est pas le sujet (formulation de secours,
 * cartes, performance) s'en servent pour que l'échéance soit PRÉSENTÉE :
 * depuis le lot 60, aucune échéance n'est affichée sans décision.
 *
 * L'empreinte est celle de l'échéance telle qu'elle est en base (même calcul
 * que la décision) : un changement significatif ultérieur la rend caduque.
 */
import type postgres from 'postgres';

export async function evaluerEcheance(
  sql: postgres.Sql,
  agendaItemId: number,
  o: { interpellation?: 'ACT_NOW' | 'ANTICIPATE' | 'LATER' | 'NONE'; priority?: 'HIGH' | 'MEDIUM' | 'LOW'; action?: string | null } = {},
): Promise<void> {
  const [i] = await sql<Array<{ account_id: number; title: string; date: string | null; forecast: boolean; rq: boolean }>>`
    SELECT account_id, title, to_char(start_date, 'YYYY-MM-DD') AS date, occurrence_nature = 'FORECAST' AS forecast,
           requires_qualification AS rq
      FROM agenda_items WHERE id = ${agendaItemId}`;
  const { agendaFingerprint } = await import('@/services/home/mascot/t6-interpellation.service');
  const { todayParis } = await import('@/services/home/mascot/collector');
  const fp = agendaFingerprint({ title: i.title, date: i.date, forecast: i.forecast, requiresQualification: i.rq });
  const interpellation = o.interpellation ?? 'ACT_NOW';
  await sql`
    INSERT INTO t6_interpellation_assessments
      (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, reason, action)
    VALUES (${i.account_id}, ${agendaItemId}, ${`agenda:${agendaItemId}`}, ${fp}, ${todayParis()}::date, ${interpellation},
            ${interpellation !== 'NONE'}, ${o.priority ?? 'MEDIUM'}, 'Évaluation enregistrée (harnais e2e).', ${o.action ?? null})
    ON CONFLICT (account_id, subject_key) DO UPDATE SET context_fingerprint = EXCLUDED.context_fingerprint,
      assessed_on = EXCLUDED.assessed_on, interpellation = EXCLUDED.interpellation, action_needed = EXCLUDED.action_needed,
      priority = EXCLUDED.priority, action = EXCLUDED.action`;
}

/** Date (AAAA-MM-JJ) dans `n` jours — dans le seuil d'interpellation pour n < 60. */
export const dansJours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
