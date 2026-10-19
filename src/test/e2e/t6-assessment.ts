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
  const [i] = await sql<Array<{ account_id: number }>>`SELECT account_id FROM agenda_items WHERE id = ${agendaItemId}`;
  // Lot 71G : empreinte ENRICHIE courante (description, documents, faits), même calcul que la décision.
  const { currentT6Fingerprints } = await import('@/services/home/mascot/t6-interpellation.service');
  const { todayParis } = await import('@/services/home/mascot/collector');
  const fp = (await currentT6Fingerprints(i.account_id, [agendaItemId])).get(agendaItemId)!;
  const interpellation = o.interpellation ?? 'ACT_NOW';
  // Lot 61 : décision du contrat `t6-evaluation-v1` (seule réutilisée par la décision).
  const decision = interpellation === 'NONE' ? 'SUPPRESS' : interpellation === 'LATER' ? 'DEFER' : 'SHOW_NOW';
  const category = interpellation === 'ANTICIPATE' ? 'TO_ANTICIPATE' : interpellation === 'ACT_NOW' ? 'ACTION_NOW' : 'INFORMATION';
  // Lot 68 : révision 2 — décision prise par le prompt COURANT (aucun renouvellement ciblé).
  const reasonCode = decision === 'SUPPRESS' ? 'NO_ACTION_REQUIRED' : decision === 'DEFER' ? 'TOO_EARLY' : 'ACTION_REQUIRED_SOON';
  await sql`
    INSERT INTO t6_interpellation_assessments
      (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, reason, action,
       contract_version, decision, category, reason_code, evidence_refs, contract_revision)
    VALUES (${i.account_id}, ${agendaItemId}, ${`agenda:${agendaItemId}`}, ${fp}, ${todayParis()}::date, ${interpellation},
            ${interpellation !== 'NONE'}, ${o.priority ?? 'MEDIUM'}, 'Évaluation enregistrée (harnais e2e).', ${o.action ?? null},
            't6-evaluation-v1', ${decision}, ${category}, ${reasonCode}, '["C1.dueDate"]'::jsonb, 2)
    ON CONFLICT (account_id, subject_key) DO UPDATE SET context_fingerprint = EXCLUDED.context_fingerprint,
      assessed_on = EXCLUDED.assessed_on, interpellation = EXCLUDED.interpellation, action_needed = EXCLUDED.action_needed,
      priority = EXCLUDED.priority, action = EXCLUDED.action, contract_version = EXCLUDED.contract_version,
      decision = EXCLUDED.decision, category = EXCLUDED.category, reason_code = EXCLUDED.reason_code, evidence_refs = EXCLUDED.evidence_refs,
      contract_revision = EXCLUDED.contract_revision`;
}

/** Date (AAAA-MM-JJ) dans `n` jours — dans le seuil d'interpellation pour n < 60. */
export const dansJours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
