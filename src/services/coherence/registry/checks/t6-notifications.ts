/**
 * Contrôles T6 et notifications du registre — lot 83E (CDC cohérence §4.7,
 * §4.10 ; arbitrages C-Q1, C-Q3, C-Q4 ; lots 81B et 81E).
 *
 * Les surveillances EXISTANTES sont ENREGISTRÉES au registre sans en dupliquer
 * la logique : le contrôle appelle leurs fonctions (état effectif d'une
 * évaluation T6, réouverture des événements regroupés 81E) et apporte ce
 * qu'elles n'avaient pas : preuve de contrôle par objet, couverture de la
 * campagne exhaustive quotidienne, recontrôle, version des règles.
 *
 *   COH-T6-EVALUATIONS  (81B) une évaluation T6 non aboutie ne reste pas
 *     bloquée : demande non prise au-delà du délai d'alerte, exécution
 *     interrompue non reprise, essai dû non exécuté, tentatives épuisées,
 *     décision réclamée en boucle, pré-génération aux tentatives épuisées.
 *     État calculé par `effectiveRunState` (81B, pur) — « PENDING n'est jamais
 *     une preuve d'exécution » (CDC §4.7). CONSTAT seulement : la reprise est
 *     celle de la chaîne T6 (essais planifiés, `mascot-t6-reevaluations`) ou
 *     la reprise EXPLICITE du BO (tentatives épuisées : aucun appel IA relancé
 *     d'office par la cohérence). Signalement : déjà fait par
 *     `mascot-t6-supervision` (anomalie par compte) — pas de second signalement.
 *   COH-NOTIF-OUTBOX  (81E) la file des notifications d'un compte avance :
 *     événement regroupé avec un incident qui n'est parti par AUCUN canal →
 *     RÉPARÉ par `reopenGroupedBy` (81E : remis en file, jamais supprimé) ;
 *     événement « en cours d'envoi » abandonné (arrêt de processus) ou dû et
 *     jamais pris → CONSTAT (le renvoyer pourrait doubler une communication
 *     déjà acceptée par un canal).
 *   COH-SUBSCRIPTION-COMMUNICATIONS  (81E) une transition d'abonnement
 *     enregistrée a ses communications : notification présente dans la file,
 *     e-mail transactionnel non en échec, inscription non en erreur. CONSTAT
 *     seulement (§4.10 : le contrôle n'émet JAMAIS de communication).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

// ══ COH-T6-EVALUATIONS ══════════════════════════════════════════════════════

/** Anomalie d'une évaluation non aboutie (pure, testée) ; null : pas de blocage. */
export function t6Anomaly(s: { state: string; stale: boolean; interrupted: boolean }, pregenExhausted: boolean): string | null {
  if (s.state === 'FAILED') return 'T6_ATTEMPTS_EXHAUSTED';
  if (s.state === 'COMPLETED') return s.stale ? 'T6_DECISION_RECLAIMED' : null;
  if (pregenExhausted) return 'T6_PREGEN_EXHAUSTED';
  if (!s.stale) return null;
  if (s.interrupted) return 'T6_INTERRUPTED_NOT_RESUMED';
  if (s.state === 'RETRY_WAIT' || s.state === 'UNAVAILABLE') return 'T6_RETRY_OVERDUE';
  return 'T6_PENDING_WITHOUT_EXECUTION';
}

export const t6EvaluationsCheck: CoherenceCheck = {
  id: 'COH-T6-EVALUATIONS',
  version: 1,
  status: 'ACTIVE',
  title: 'T6 : aucune évaluation d’échéance bloquée ou épuisée sans reprise',
  domain: 't6',
  level: 'N2',
  objectType: 'agenda_item',
  scope: 'évaluations T6 du compte (une par échéance, `t6_evaluation_runs`)',
  sources: ['t6_evaluation_runs', 'home_mascot_pregen_requests'],
  applicability: 'compte éligible ; table 0616 présente',
  invariant: 'une évaluation non aboutie est réellement en cours ou planifiée dans le délai d’alerte ; un PENDING n’est jamais une preuve d’exécution',
  anomalies: ['T6_PENDING_WITHOUT_EXECUTION', 'T6_INTERRUPTED_NOT_RESUMED', 'T6_RETRY_OVERDUE', 'T6_ATTEMPTS_EXHAUSTED', 'T6_DECISION_RECLAIMED', 'T6_PREGEN_EXHAUSTED'],
  autoRepairWhen: 'jamais par la cohérence : reprise par la chaîne T6 (essais planifiés) ou reprise explicite au BO (tentatives épuisées)',
  forbiddenRepairs: ['relancer T6 (IA) d’office', 'clore une évaluation sans décision enregistrée', 'remettre les tentatives à zéro'],
  services: ['home/mascot/t6-evaluation-runs#effectiveRunState', 'home/mascot/t6-evaluation-runs#loadT6Runs'],
  chain: ['T4', 'PERSISTENCE'],
  triggers: ['AGENDA_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (supervision 81B toutes les 5 min)',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-06', 'L83E-U-T6'],
  externalSupervision: 'mascot-t6-supervision (anomalie « T6 : évaluations d’échéances bloquées » par compte)',

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT agenda_item_id AS id FROM t6_evaluation_runs WHERE account_id = $1 AND agenda_item_id > $2 ORDER BY agenda_item_id LIMIT $3`,
    [accountId, afterId, limit]).catch((e: Error) => {
      if (/t6_evaluation_runs/.test(e.message) && /does not exist/.test(e.message)) return [];
      throw e;
    }));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT agenda_item_id AS id FROM t6_evaluation_runs WHERE account_id = $1 AND agenda_item_id = $2`, [accountId, e.entityId]).catch(() => []));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const t6 = await import('@/services/home/mascot/t6-evaluation-runs');
    const runs = await t6.loadT6Runs(accountId, ids);
    const [ex] = await rows(ctx.sql, `
      SELECT EXISTS (SELECT 1 FROM home_mascot_pregen_requests WHERE account_id = $1 AND last_status = 'attempts_exhausted') AS e`, [accountId])
      .catch(() => [{ e: false }]);
    const epuisee = ex?.e === true;
    for (const id of ids) {
      const run = runs.get(id);
      if (!run) { out.set(id, { verdict: 'GONE' }); continue; }
      const s = t6.effectiveRunState(run, ctx.now);
      const anomaly = t6Anomaly(s, epuisee && run.status !== 'COMPLETED');
      const detail = { status: run.status, state: s.state, attempts: s.attempts, since: s.since, lastErrorKind: s.lastErrorKind, nextAttemptAt: s.nextAttemptAt };
      if (!anomaly) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: 'FINDING', anomaly, faultyLink: 'PERSISTENCE', expected: 'évaluation en cours, planifiée ou aboutie', observed: detail, detail,
        inputHash: hashOf({ id, status: run.status, attempts: run.attempts, fp: run.fingerprint, err: run.lastErrorKind }),
      });
    }
    return out;
  },
};

// ══ COH-NOTIF-OUTBOX ════════════════════════════════════════════════════════

/** Délai au-delà duquel un événement dû non pris, ou « en cours d'envoi », est anormal. */
const OUTBOX_STALE_MINUTES = 30;

export const notificationOutboxCheck: CoherenceCheck = {
  id: 'COH-NOTIF-OUTBOX',
  version: 1,
  status: 'ACTIVE',
  title: 'Notifications : la file d’envoi du compte avance (regroupements, envois abandonnés)',
  domain: 'notifications',
  level: 'N2',
  objectType: 'account',
  scope: 'file des notifications du compte (`notification_outbox`), un objet par compte qui en a',
  sources: ['notification_outbox'],
  applicability: 'compte éligible',
  invariant: 'aucun événement regroupé avec un incident jamais parti ; aucun événement « en cours » abandonné ou dû non pris au-delà du délai',
  anomalies: ['GROUPED_WITH_UNSENT_CARRIER', 'OUTBOX_PROCESSING_ABANDONED', 'OUTBOX_PENDING_OVERDUE'],
  autoRepairWhen: 'événements regroupés avec un incident en échec ou ignoré : remis en file par le service 81E (`reopenGroupedBy`)',
  forbiddenRepairs: ['renvoyer un événement « en cours d’envoi » (doublon possible)', 'émettre une communication pour signaler une anomalie', 'supprimer un événement'],
  services: ['lib/notifications/outbox#reopenGroupedBy'],
  chain: ['PERSISTENCE'],
  // Une transition d'abonnement émet des notifications (81E).
  triggers: ['PLAN_CHANGED'],
  frequency: 'campagne exhaustive quotidienne (envoi : toutes les minutes)',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-06'],

  async listObjects(ctx, accountId, afterId) {
    if (afterId >= accountId) return [];
    const [r] = await rows(ctx.sql, `SELECT EXISTS (SELECT 1 FROM notification_outbox WHERE account_id = $1) AS e`, [accountId]);
    return r?.e === true ? [accountId] : [];
  },

  async objectsForEvent(ctx, accountId) {
    return this.listObjects!(ctx, accountId, 0, 1);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    for (const id of ids) {
      if (id !== accountId) { out.set(id, { verdict: 'GONE' }); continue; }
      const [x] = await rows(ctx.sql, `
        SELECT (SELECT array_agg(DISTINCT g.grouped_with_id::text) FROM notification_outbox g
                  JOIN notification_outbox c ON c.id = g.grouped_with_id
                 WHERE g.account_id = $1 AND g.status = 'grouped' AND c.status IN ('failed', 'skipped')) AS carriers,
               (SELECT count(*)::int FROM notification_outbox WHERE account_id = $1 AND status = 'processing'
                  AND COALESCE(processed_at, created_at) < $2::timestamptz) AS abandoned,
               (SELECT count(*)::int FROM notification_outbox WHERE account_id = $1 AND status = 'pending'
                  AND COALESCE(scheduled_for, created_at) < $2::timestamptz) AS overdue`,
      [accountId, new Date(ctx.now.getTime() - OUTBOX_STALE_MINUTES * 60_000)]);
      const carriers = ((x?.carriers as string[] | null) ?? []).filter(Boolean).sort();
      const detail = { carriers, abandoned: Number(x?.abandoned ?? 0), overdue: Number(x?.overdue ?? 0) };
      if (carriers.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'GROUPED_WITH_UNSENT_CARRIER', faultyLink: 'PERSISTENCE',
          expected: 'événements regroupés remis en file (incident jamais parti)', observed: detail, detail, inputHash: hashOf({ id, carriers }),
        });
      } else if (detail.abandoned > 0 || detail.overdue > 0) {
        out.set(id, {
          verdict: 'FINDING', anomaly: detail.abandoned > 0 ? 'OUTBOX_PROCESSING_ABANDONED' : 'OUTBOX_PENDING_OVERDUE', faultyLink: 'PERSISTENCE',
          expected: `aucun événement en attente depuis plus de ${OUTBOX_STALE_MINUTES} min`, observed: detail, detail, inputHash: hashOf({ id, ...detail }),
        });
      } else {
        out.set(id, { verdict: 'CONSISTENT', detail });
      }
    }
    return out;
  },

  async repair(_ctx, _accountId, items) {
    const out = new Map<number, RepairResult>();
    const { reopenGroupedBy } = await import('@/lib/notifications/outbox');
    for (const { id, inspection } of items) {
      const carriers = ((inspection.detail as { carriers?: string[] } | undefined)?.carriers ?? []);
      let reopened = 0;
      for (const c of carriers) reopened += (await reopenGroupedBy(c)).length;
      out.set(id, { called: true, service: 'reopenGroupedBy', aiCalls: 0, result: { carriers: carriers.length, reopened }, rollbackRef: `notification_outbox:grouped_with_id IN (${carriers.join(',')})`.slice(0, 300) });
    }
    return out;
  },
};

// ══ COH-SUBSCRIPTION-COMMUNICATIONS ═════════════════════════════════════════

export const subscriptionCommunicationsCheck: CoherenceCheck = {
  id: 'COH-SUBSCRIPTION-COMMUNICATIONS',
  version: 1,
  status: 'ACTIVE',
  title: 'Abonnement : chaque transition enregistrée a ses communications (notification, e-mail contractuel)',
  domain: 'notifications',
  level: 'N3',
  objectType: 'subscription_communication_operation',
  scope: 'transitions d’abonnement du compte (`subscription_communication_operations`)',
  sources: ['subscription_communication_operations', 'notification_outbox', 'transactional_email_jobs'],
  applicability: 'compte éligible ou non éligible du fait de son abonnement (lecture seule)',
  invariant: 'une transition dont les communications ont été décidées les a inscrites : notification dans la file, e-mail transactionnel non en échec',
  anomalies: ['COMMUNICATIONS_NOT_RECORDED', 'NOTIFICATION_MISSING', 'TRANSACTIONAL_EMAIL_FAILED'],
  autoRepairWhen: 'jamais (le contrôle n’émet aucune communication — CDC §4.10)',
  forbiddenRepairs: ['émettre ou réémettre une communication', 'modifier la transition', 'toucher à Stripe'],
  services: ['billing/subscription-communications.service#recordSubscriptionTransition (lecture de ses inscriptions)'],
  chain: ['PERSISTENCE'],
  triggers: ['PLAN_CHANGED'],
  frequency: 'campagne exhaustive quotidienne',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-07'],
  ineligibleAccounts: 'SUBSCRIPTION_STATE_READ',

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT id FROM subscription_communication_operations WHERE account_id = $1 AND id > $2 ORDER BY id LIMIT $3`, [accountId, afterId, limit])
      .catch((e: Error) => {
        if (/subscription_communication_operations/.test(e.message) && /does not exist/.test(e.message)) return [];
        throw e;
      }));
  },

  async objectsForEvent(ctx, accountId) {
    // Transitions inscrites dans les dernières 24 h (la communication part dans la minute).
    return idsOf(await rows(ctx.sql, `
      SELECT id FROM subscription_communication_operations WHERE account_id = $1 AND created_at >= $2::timestamptz ORDER BY id`,
    [accountId, new Date(ctx.now.getTime() - 86_400_000)]).catch(() => []));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT o.id, o.kind, o.communications_skipped, o.notification_dedupe_key, o.email_job_id,
             (o.notification_dedupe_key IS NULL OR EXISTS (SELECT 1 FROM notification_outbox n WHERE n.dedupe_key = o.notification_dedupe_key)) AS notification_ok,
             (SELECT j.status FROM transactional_email_jobs j WHERE j.id = o.email_job_id) AS email_status
        FROM subscription_communication_operations o WHERE o.account_id = $1 AND o.id = ANY($2::int[])`, [accountId, intArray(ids)]);
    const parId = new Map(r.map((x) => [Number(x.id), x]));
    for (const id of ids) {
      const x = parId.get(id);
      if (!x) { out.set(id, { verdict: 'GONE' }); continue; }
      const detail = { kind: x.kind, skipped: x.communications_skipped ?? null, emailJobId: x.email_job_id ?? null, emailStatus: x.email_status ?? null };
      const anomaly = String(x.communications_skipped ?? '').startsWith('ERROR:') ? 'COMMUNICATIONS_NOT_RECORDED'
        : x.notification_ok !== true ? 'NOTIFICATION_MISSING'
          : x.email_status === 'failed' ? 'TRANSACTIONAL_EMAIL_FAILED' : null;
      if (!anomaly) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, { verdict: 'FINDING', anomaly, faultyLink: 'PERSISTENCE', observed: detail, detail, inputHash: hashOf({ id, anomaly, ...detail }) });
    }
    return out;
  },
};
