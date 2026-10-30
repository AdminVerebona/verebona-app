/**
 * Signalement du contrôle de cohérence dans la Supervision EXISTANTE — lot
 * 82B (arbitrage C-Q3 : aucun onglet « Cohérence » ; seules les anomalies
 * persistantes, erreurs de réparation, contradictions bloquantes ou
 * répétitions anormales remontent ; une anomalie corrigée ne crée aucune
 * action manuelle).
 *
 * Même modèle que `operations-quality-check` : une anomalie AGRÉGÉE par
 * contrôle et par nature (empreinte `other:coherence:<contrôle>:<nature>`,
 * domaine « Autres traitements techniques »), consolidée par
 * `reportAnomaly`, résolue automatiquement (SUP-008) quand le décompte revient
 * à zéro. Natures :
 *   repair_failed     réparations en échec technique (service métier) ;
 *   persistent        constats non résolus depuis au moins
 *                     `PERSISTENT_STREAK` contrôles (réparation inefficace
 *                     ou suspendue, constat sans réparation automatique,
 *                     relance asynchrone toujours sans résultat — lot 83B) ;
 *   errors            contrôles en erreur répétée (aucun succès) ;
 *   repeated_repairs  même objet réparé au moins `REPEATED_REPAIRS` fois en
 *                     7 jours : la cause est ailleurs (chaîne qui recrée
 *                     l'écart) ;
 *   campaign          dernière campagne quotidienne PARTIELLE ou ÉCHOUÉE ;
 *   <anomalie>        lot 91B : constat déclaré « immédiat » par son contrôle
 *                     (`immediateSupervision` : contrat IA absent, journal
 *                     inutilisable…) — signalé dès le PREMIER constat, avec
 *                     les comptes et la demande IA, résolu quand plus aucun
 *                     objet ne le porte.
 * Les constats AMBIGUOUS (arbitrage existant) et WOULD_REPAIR (mode à blanc)
 * ne sont pas signalés : ils relèvent de mécanismes existants ou de la
 * recette. Les preuves anciennes (compte sorti du périmètre) sont ignorées.
 *
 * Lot 83E : un contrôle dont les constats sont DÉJÀ signalés par une
 * supervision existante (`externalSupervision` : T6 → `mascot-t6-supervision`,
 * notifications → anomalies de canal / de communication) n'ouvre pas de
 * second signalement « persistant » ; ses échecs de réparation et erreurs de
 * contrôle restent signalés ici.
 */
import { pgClient } from '@/db';
import type { Sql } from './registry/types';
import { rows } from './registry/util';
import { activeChecks, getCheck } from './registry';

const COHERENCE_ANOMALY_PREFIX = 'other:coherence:';
const PERSISTENT_STREAK = 3;
const REPEATED_REPAIRS = 3;
/** Fenêtre des preuves prises en compte (comptes encore contrôlés). */
const RECENT_HOURS = 36;

interface CoherenceAlert {
  fingerprint: string;
  title: string;
  count: number;
  detail: Record<string, unknown>;
}

/** Lot 91D — libellés des qualifications de constat (Supervision). */
export const QUALIFICATION_LABELS: Readonly<Record<string, string>> = {
  UNJUSTIFIED_OMISSION: 'omissions non justifiées',
  UNDETERMINED_DECISION: 'décisions T1 indéterminées',
  REPAIR_TECHNICAL: 'problèmes techniques de reprise',
  EXTRACT_TECHNICAL: 'extraction incomplète',
  DOWNSTREAM: 'exploitation aval',
};

export const fingerprintOf = (checkId: string, nature: string) => `${COHERENCE_ANOMALY_PREFIX}${checkId.toLowerCase()}:${nature}`;

/** Calcule les alertes agrégées (lecture seule). */
export async function computeCoherenceAlerts(now: Date = new Date(), sql: Sql = pgClient): Promise<CoherenceAlert[]> {
  const depuis = new Date(now.getTime() - RECENT_HOURS * 3_600_000);
  const alerts: CoherenceAlert[] = [];
  const agreg = await rows(sql, `
    SELECT check_id,
           count(*) FILTER (WHERE last_result = 'REPAIR_FAILED')::int AS repair_failed,
           count(*) FILTER (WHERE finding_streak >= $2 AND last_result IN ('FINDING', 'REPAIR_INEFFECTIVE', 'REPAIR_SUPPRESSED', 'REPAIR_PENDING'))::int AS persistent,
           count(*) FILTER (WHERE consecutive_errors >= 2)::int AS errors,
           (array_agg(account_id ORDER BY account_id) FILTER (WHERE last_result = 'REPAIR_FAILED' OR consecutive_errors >= 2
                                                              OR (finding_streak >= $2 AND last_result IN ('FINDING', 'REPAIR_INEFFECTIVE', 'REPAIR_SUPPRESSED', 'REPAIR_PENDING'))))[1:20] AS accounts,
           (array_agg(DISTINCT finding->>'anomaly') FILTER (WHERE finding_streak >= $2 AND last_result IN ('FINDING', 'REPAIR_INEFFECTIVE', 'REPAIR_SUPPRESSED', 'REPAIR_PENDING'))) AS anomalies
      FROM coherence_object_proofs
     WHERE COALESCE(last_completed_at, last_started_at) >= $1
     GROUP BY check_id`, [depuis, PERSISTENT_STREAK]);
  // Lot 91D : qualification des constats persistants (omission non justifiée, décision indéterminée, problème
  // technique de reprise…) quand le contrôle la déclare (`detail.qualification`) — la Supervision les distingue.
  const qualifs = new Map<string, string>();
  for (const q of await rows(sql, `
    SELECT check_id, finding->'detail'->>'qualification' AS q, count(*)::int AS n FROM coherence_object_proofs
     WHERE COALESCE(last_completed_at, last_started_at) >= $1 AND finding_streak >= $2
       AND last_result IN ('FINDING', 'REPAIR_INEFFECTIVE', 'REPAIR_SUPPRESSED', 'REPAIR_PENDING')
       AND finding->'detail'->>'qualification' IS NOT NULL
     GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [depuis, PERSISTENT_STREAK])) {
    const id = String(q.check_id);
    qualifs.set(id, [qualifs.get(id), `${QUALIFICATION_LABELS[String(q.q)] ?? String(q.q)} : ${q.n}`].filter(Boolean).join(' · '));
  }
  for (const a of agreg) {
    const id = String(a.check_id);
    const comptes = [...new Set(((a.accounts as number[] | null) ?? []).map(Number))];
    const base = { checkId: id, accountIds: comptes.join(', '), boLink: '/admin/exploitation' };
    if (Number(a.repair_failed) > 0) alerts.push({ fingerprint: fingerprintOf(id, 'repair_failed'), title: `Cohérence ${id} : réparations en échec (${a.repair_failed})`, count: Number(a.repair_failed), detail: base });
    if (Number(a.persistent) > 0 && !getCheck(id)?.externalSupervision) {
      alerts.push({ fingerprint: fingerprintOf(id, 'persistent'), title: `Cohérence ${id} : constats persistants (${a.persistent})`, count: Number(a.persistent),
        detail: { ...base, anomalies: ((a.anomalies as string[] | null) ?? []).filter(Boolean).join(', '), ...(qualifs.has(id) ? { qualifications: qualifs.get(id) } : {}) } });
    }
    if (Number(a.errors) > 0) alerts.push({ fingerprint: fingerprintOf(id, 'errors'), title: `Cohérence ${id} : contrôles en erreur répétée (${a.errors})`, count: Number(a.errors), detail: base });
  }
  // Lot 91B : constats « immédiats » (défaut de configuration exploitable) — dès le premier constat.
  const immediats = [...new Set(activeChecks().flatMap((c) => c.immediateSupervision ?? []))];
  if (immediats.length) {
    const constats = await rows(sql, `
      SELECT check_id, finding->>'anomaly' AS anomaly, count(*)::int AS n, (array_agg(DISTINCT account_id))[1:20] AS accounts,
             max(finding->'detail'->>'pendingContract') AS pending_contract
        FROM coherence_object_proofs
       WHERE COALESCE(last_completed_at, last_started_at) >= $1 AND last_result = 'FINDING' AND finding->>'anomaly' = ANY($2::text[])
       GROUP BY check_id, finding->>'anomaly'`, [depuis, immediats]);
    for (const c of constats) {
      const id = String(c.check_id);
      const anomalie = String(c.anomaly);
      if (!(getCheck(id)?.immediateSupervision ?? []).includes(anomalie)) continue;
      alerts.push({
        fingerprint: fingerprintOf(id, anomalie.toLowerCase()), title: `Cohérence ${id} : ${anomalie} (${c.n} objet(s))${c.pending_contract ? ` — demande IA ${c.pending_contract}` : ''}`,
        count: Number(c.n),
        detail: { checkId: id, anomaly: anomalie, accountIds: ((c.accounts as number[] | null) ?? []).join(', '), pendingContract: c.pending_contract ?? null,
          boLink: '/admin/exploitation', guide: 'docs/exploitation/prompts-a-appliquer-par-le-po.md' },
      });
    }
  }
  // Lot 98B (P0-E) : cartes « À traiter » OUVERTES mais RETENUES (maintien technique : T4 incompatible,
  // interprétation T3 en attente, panne IA, évaluation en erreur ; lot 100E : décision de famille différée,
  // règle sans contrat déclaré — toutes familles) — non publiées à l'utilisateur ; cause et
  // nouvelle tentative (automatique : contrôle de cohérence ; manuelle : BO › IA › File d'attente).
  const { heldCardsOverview, HOLD_CAUSE_LABELS } = await import('@/services/to-process/publishability');
  for (const g of await heldCardsOverview({ sql: sql as never })) {
    alerts.push({
      fingerprint: `${COHERENCE_ANOMALY_PREFIX}a-traiter-retenues:${g.cause.toLowerCase()}`,
      title: `« À traiter » : ${g.count} carte(s) retenue(s), non publiée(s) — ${HOLD_CAUSE_LABELS[g.cause]}`,
      count: g.count,
      detail: {
        cause: g.cause, causeLabel: HOLD_CAUSE_LABELS[g.cause], accountIds: g.accountIds.join(', '),
        // Lot 100E (A7) : toutes familles (documents, agenda, équipements, fournisseurs…).
        families: (g.families ?? []).join(', '),
        retry: g.cause === 'RULE_NOT_DECLARED'
          ? 'aucune : déclarer la règle dans le contrat commun (src/services/to-process/publishability.ts) — les cartes restent ouvertes, non montrées'
          : 'automatique : contrôle de cohérence (COH-TODO-DOCUMENT-FIELDS, COH-TODO-RELEVANCE-CARDS) dès que la cause est levée ; manuelle : BO › IA › File d’attente › « À traiter » › Nouvelle tentative',
        boLink: '/admin/ai-queue',
        ...(g.cause === 'T4_INCOMPATIBLE' || g.cause === 'INTERPRETATION_PENDING' ? { guide: 'docs/exploitation/prompts-a-appliquer-par-le-po.md' } : {}),
      },
    });
  }
  const repetes = await rows(sql, `
    SELECT check_id, count(*)::int AS n, (array_agg(DISTINCT account_id))[1:20] AS accounts FROM (
      SELECT check_id, account_id, object_id FROM coherence_repairs
       WHERE outcome = 'REPAIRED' AND created_at >= $1 GROUP BY check_id, account_id, object_id HAVING count(*) >= $2) x
     GROUP BY check_id`, [new Date(now.getTime() - 7 * 86_400_000), REPEATED_REPAIRS]);
  for (const r of repetes) {
    const id = String(r.check_id);
    alerts.push({ fingerprint: fingerprintOf(id, 'repeated_repairs'), title: `Cohérence ${id} : objets réparés de façon répétée (${r.n})`, count: Number(r.n),
      detail: { checkId: id, accountIds: ((r.accounts as number[]) ?? []).join(', ') } });
  }
  const [derniere] = await rows(sql, `
    SELECT id, status, coverage, remaining, campaign_date::text AS d FROM coherence_campaigns
     WHERE kind = 'DAILY' AND status <> 'RUNNING' ORDER BY campaign_date DESC LIMIT 1`);
  if (derniere && derniere.status !== 'COMPLETE') {
    alerts.push({ fingerprint: `${COHERENCE_ANOMALY_PREFIX}campaign:daily`, title: `Cohérence : campagne quotidienne du ${derniere.d} ${derniere.status === 'PARTIAL' ? 'partielle' : 'en échec'} (non exhaustive)`,
      count: 1, detail: { campaignId: Number(derniere.id), status: derniere.status, remaining: derniere.remaining ?? null } });
  }
  return alerts;
}

/** Ouvre / consolide les alertes actives et résout celles revenues à zéro. Ne lève pas. */
export async function syncCoherenceSupervision(o: { now?: Date; sql?: Sql } = {}): Promise<{ reported: number; resolved: number }> {
  const sql = o.sql ?? pgClient;
  try {
    const alerts = await computeCoherenceAlerts(o.now ?? new Date(), sql);
    const { reportAnomaly, autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    let reported = 0;
    for (const a of alerts) {
      const id = await reportAnomaly({ domain: 'other', fingerprint: a.fingerprint, title: a.title.slice(0, 200), detail: { ...a.detail, count: a.count, procedure: 'docs/exploitation/taches-planifiees.md (coherence-control)' } });
      if (id !== null) reported++;
    }
    const actives = new Set(alerts.map((a) => a.fingerprint));
    const ouvertes = (await rows(sql, `SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE $1`, [`${COHERENCE_ANOMALY_PREFIX}%`]))
      .map((r) => String(r.fingerprint));
    let resolved = 0;
    for (const f of ouvertes.filter((x) => !actives.has(x))) {
      if (await autoResolveAnomaly(f, { origin: 'coherence_control_cleared', cause: 'Décompte revenu à zéro (contrôle de cohérence)' })) resolved++;
    }
    return { reported, resolved };
  } catch (e) {
    console.error('[coherence] supervision impossible :', (e as Error).message);
    return { reported: 0, resolved: 0 };
  }
}
