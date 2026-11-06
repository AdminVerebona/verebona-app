/**
 * Lot 105B, refondu lot 113I — SURVEILLANCE des candidates activées
 * automatiquement — tâche planifiée EXISTANTE `ai-promotion-watch` (toutes les
 * heures, préproduction seulement ; production : sans objet), même bail
 * `ai-promotion-watch:<env>` (SQL-011 : aucun second surveillant).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CDC V2 §12 (MON-01..10, C-002, DATA-05) — règle définitive des sept jours :
 *   · la surveillance est rattachée au TRAITEMENT et à l'EMPREINTE de la
 *     configuration effectivement servie (pas à l'identifiant de la version
 *     globale) ; elle est créée DANS la transaction de promotion (SQL-006) ;
 *   · 72 h = fenêtre initiale de référence, J+7 = bilan d'observabilité : ni
 *     l'un ni l'autre ne clôt, ne suspend, ne rejette ni ne valide ;
 *   · données insuffisantes → INSUFFICIENT_USAGE, télémétrie illisible →
 *     OBSERVATION_UNAVAILABLE : candidate CONSERVÉE, surveillance passive
 *     maintenue, aucun test payant pour « remplir le quota » ;
 *   · usage suffisant sans dégradation → VALIDATED_IN_USAGE (date et preuve) ;
 *   · alerte non critique (latence, coût) → ALERT, candidate conservée ;
 *   · régression démontrée ET imputable → RETOUR ARRIÈRE CIBLÉ du seul
 *     traitement (`rollbackPromotedTreatment`), sans attendre 72 h ni J+7 ;
 *     impossible → ROLLBACK_FAILED (alerte critique, jamais « réussi ») ;
 *   · le traitement effectif a changé (geste humain, autre promotion du même
 *     traitement) → REPLACED, sans juger la candidate défectueuse ; une
 *     modification d'un AUTRE traitement n'arrête pas la surveillance (MON-10).
 * Idempotent (état dans `candidate_promotion.watch`, transitions journalisées
 * une fois), aucun effet externe ; rejeu payant seulement sur suspicion (MON-06,
 * budget de surveillance).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import { treatmentOfUseCase, type Treatment } from '../config/treatments';
import { AI_OPERATIONS } from '../registry/operations';
import { evaluatePostActivation, type PostVerdict } from './post-activation';
import { recordPromotionEvent } from './promotion-journal';
import { promotionParams } from './promotion-params';
import type { CampaignDeps } from './campaign';
import type { TargetedPromotionRecord } from '../config/config-version.repository';

export interface WatchSummary {
  environment: string;
  watched: number;
  rolledBack: number;
  alerts: number;
  /** Compatibilité : toujours 0 depuis le lot 113I (aucune clôture par le temps). */
  resolved: number;
  replaced: number;
  replays: number;
  validated: number;
  insufficient: number;
  unavailable: number;
  rollbackFailed: number;
  skipped?: string;
}

export type WatchStatus =
  | 'WATCHING' | 'INSUFFICIENT_USAGE' | 'OBSERVATION_UNAVAILABLE' | 'VALIDATED_IN_USAGE' | 'ALERT'
  | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'REPLACED' | 'LEGACY_OBSERVATION_UNKNOWN'
  /** Historique (lot 105B, règle abrogée) — lu, jamais écrit. */
  | 'RESOLVED';

/** États où la surveillance passive continue (la candidate reste effective). */
export const ACTIVE_WATCH_STATES: readonly WatchStatus[] = ['WATCHING', 'INSUFFICIENT_USAGE', 'OBSERVATION_UNAVAILABLE', 'VALIDATED_IN_USAGE', 'ALERT'];

/** Libellés BO exacts (BO-07, APIX-003). */
export const WATCH_STATUS_LABELS: Readonly<Record<WatchStatus, string>> = {
  WATCHING: 'Active — surveillance initiale en cours',
  INSUFFICIENT_USAGE: 'Qualification acquise ; observations d’usage insuffisantes ; configuration conservée',
  OBSERVATION_UNAVAILABLE: 'Observation indisponible (télémétrie illisible) : aucune conclusion, configuration conservée',
  VALIDATED_IN_USAGE: 'Validée en usage',
  ALERT: 'Alerte non critique : configuration conservée',
  ROLLED_BACK: 'Retour arrière ciblé effectué (régression imputable prouvée)',
  ROLLBACK_FAILED: 'Régression prouvée, retour arrière IMPOSSIBLE : intervention requise',
  REPLACED: 'Remplacée par une autre décision (non jugée défectueuse)',
  LEGACY_OBSERVATION_UNKNOWN: 'Surveillance antérieure non reconstituable (aucune conclusion)',
  RESOLVED: 'Clôturée par l’ancienne règle de fenêtre (abrogée)',
};

export interface WatchState {
  status: WatchStatus;
  treatment: Treatment;
  /** Empreinte de la configuration promue du traitement (null : activation antérieure au lot 113I). */
  fingerprint: string | null;
  activatedAt: string;
  initialWindowEnd: string;
  sevenDayReviewAt: string;
  /** Compatibilité lecture (= fin de fenêtre initiale) — n'est plus une échéance. */
  watchUntil: string;
  previousVersionId: number | null;
  /** Versions globales qui ont servi la configuration promue (attribution des signaux, MON-10). */
  servingVersionIds: number[];
  operations: string[];
  campaignId: number | null;
  replays: number;
  alerts: string[];
  checks: number;
  milestones?: { h72?: string; j7?: string };
  lastVerdict?: PostVerdict;
  lastCheckAt?: string;
  lastObservedAt?: string | null;
  lastSignals?: unknown;
  validatedAt?: string;
  monitorReason?: string;
  endedAt?: string;
  endReason?: string;
}

/** Opérations modèle du traitement (registre courant, jamais une liste figée). */
export function operationsOfTreatment(t: Treatment): string[] {
  return Object.values(AI_OPERATIONS).filter((o) => { try { return treatmentOfUseCase(o.useCaseCode) === t; } catch { return false; } }).map((o) => o.operationCode);
}

/** Surveillance initiale persistée dans la transaction de promotion (SQL-006). */
export function initialWatch(t: TargetedPromotionRecord, p: { campaignId: number | null; operations?: readonly string[]; previousVersionId: number | null; now?: Date }): WatchState {
  const w = promotionParams().watch;
  const at = p.now ?? new Date(t.promotedAt);
  const fin = new Date(at.getTime() + w.windowMs).toISOString();
  return {
    status: 'WATCHING', treatment: t.treatment, fingerprint: t.afterFingerprint, activatedAt: at.toISOString(),
    initialWindowEnd: fin, watchUntil: fin, sevenDayReviewAt: new Date(at.getTime() + w.sevenDayReviewMs).toISOString(),
    previousVersionId: p.previousVersionId ?? t.globalActiveBefore?.versionId ?? null,
    servingVersionIds: [t.globalActiveAfter.versionId], operations: [...new Set(p.operations?.length ? p.operations : operationsOfTreatment(t.treatment))],
    campaignId: p.campaignId, replays: 0, alerts: [], checks: 0, milestones: {},
  };
}

/**
 * État de surveillance (pur) à partir du verdict et des jalons. Jamais de clôture par le temps : les jalons ne
 * font que distinguer WATCHING (fenêtre initiale) d'INSUFFICIENT_USAGE (au-delà, sans preuve suffisante).
 */
export function nextWatchStatus(p: { verdict: PostVerdict; afterCalls: number; minCallsValidated: number; now: Date; initialWindowEnd: string; previous: WatchStatus }): WatchStatus {
  if (p.verdict === 'OBSERVATION_UNAVAILABLE') return 'OBSERVATION_UNAVAILABLE';
  if (p.verdict === 'ALERT') return 'ALERT';
  if (p.verdict === 'OK' && p.afterCalls >= p.minCallsValidated) return 'VALIDATED_IN_USAGE';
  if (p.previous === 'VALIDATED_IN_USAGE') return 'VALIDATED_IN_USAGE';
  return p.now.getTime() >= Date.parse(p.initialWindowEnd) ? 'INSUFFICIENT_USAGE' : 'WATCHING';
}

export async function runPromotionWatch(p: { trigger: string; now?: () => Date; environment?: AiEnvironment; campaign?: CampaignDeps; skipLease?: boolean } = { trigger: 'manual' }): Promise<WatchSummary> {
  const env = p.environment ?? getAiEnvironment();
  const sum: WatchSummary = { environment: env, watched: 0, rolledBack: 0, alerts: 0, resolved: 0, replaced: 0, replays: 0, validated: 0, insufficient: 0, unavailable: 0, rollbackFailed: 0 };
  if (env === 'production') return { ...sum, skipped: 'production : aucune activation automatique, rien à surveiller (R9)' };
  const travail = async () => {
    const cfg = await import('../config/config-version.repository');
    const now = (p.now ?? (() => new Date()))();
    // FIN-005 / OPS-07 : réservations orphelines → non rapprochées ; coûts désormais connus → réglés (non bloquant).
    await (await import('./improvement-budget')).sweepReservations({ environment: env, now }).catch(() => undefined);
    const { loadPolicy } = await import('./improvement-policy');
    const policy = await loadPolicy(env).catch(() => null);
    const minValidated = policy?.usage.minCallsValidated ?? promotionParams().watch.minCalls;
    const actives = (await cfg.listCandidates(env, ['ACTIVATED'])).filter((c) => ACTIVE_WATCH_STATES.includes((c.promotion.watch as WatchState | undefined)?.status as WatchStatus));
    for (const c of actives) {
      const w0 = c.promotion.watch as WatchState;
      const targeted = (c.promotion.targeted ?? null) as TargetedPromotionRecord | null;
      const w: WatchState = { ...w0, servingVersionIds: w0.servingVersionIds ?? [c.id], fingerprint: w0.fingerprint ?? targeted?.afterFingerprint ?? null,
        initialWindowEnd: w0.initialWindowEnd ?? w0.watchUntil, sevenDayReviewAt: w0.sevenDayReviewAt ?? new Date(Date.parse(w0.activatedAt) + promotionParams().watch.sevenDayReviewMs).toISOString() };
      sum.watched += 1;
      const journal = async (kind: 'WATCH_STATE' | 'WATCH_END' | 'POST_CHECK' | 'POST_ALERT' | 'TARGETED_ROLLBACK' | 'ROLLBACK_REFUSED' | 'ROLLBACK_FAILED', code: string, message: string, reference: Record<string, unknown> = {}, allowed: boolean | null = null) =>
        recordPromotionEvent({ environment: env, kind, candidateVersionId: c.id, campaignId: w.campaignId, treatment: w.treatment, allowed, code, message: message.slice(0, 2000), reference });
      const enregistrer = async (s: WatchState) => { await cfg.mergeCandidatePromotion(c.id, { watch: s }); };

      // 1. La configuration du TRAITEMENT est-elle toujours celle promue ? (MON-10 : un autre traitement ne compte pas)
      let effective: { versionId: number; fingerprint: string } | null;
      try {
        effective = await cfg.activeTreatmentFingerprint(env, w.treatment);
      } catch (e) {
        const s: WatchState = { ...w, status: 'OBSERVATION_UNAVAILABLE', checks: (w.checks ?? 0) + 1, lastCheckAt: now.toISOString(), monitorReason: `configuration active illisible (${(e as Error).message.slice(0, 120)})` };
        if (w.status !== 'OBSERVATION_UNAVAILABLE') await journal('WATCH_STATE', 'OBSERVATION_UNAVAILABLE', `Surveillance de ${w.treatment} : configuration active illisible — aucune conclusion, configuration conservée.`);
        sum.unavailable += 1;
        await enregistrer(s);
        continue;
      }
      const toujours = w.fingerprint ? effective?.fingerprint === w.fingerprint : effective?.versionId === c.id;
      if (!toujours) {
        sum.replaced += 1;
        await enregistrer({ ...w, status: 'REPLACED', endedAt: now.toISOString(), endReason: `La configuration de ${w.treatment} a été remplacée (intervention administrative ou autre promotion) : surveillance arrêtée, candidate non jugée défectueuse.` });
        await journal('WATCH_END', 'REPLACED', `Candidate ${c.id} : configuration de ${w.treatment} remplacée — choix respecté, rien n’est imputé, aucun retour arrière.`, { effectiveVersionId: effective?.versionId ?? null });
        continue;
      }
      const serving = [...new Set([...w.servingVersionIds, ...(effective ? [effective.versionId] : [])])];

      // 2. Signaux d'usage attribués + rejeu certifié seulement sur suspicion.
      const ev = await evaluatePostActivation({
        treatment: w.treatment, operations: w.operations, candidateVersionId: c.id, previousVersionId: w.previousVersionId, servingVersionIds: serving,
        activatedAt: new Date(w.activatedAt), now, replaysDone: w.replays ?? 0, candidateActive: true,
        replay: async (x) => (await import('./campaign')).requestPostActivationReplay(x, p.campaign ?? {}),
      });
      const a = ev.assessment;
      if (ev.replay) sum.replays += 1;
      const signals = { verdict: a.verdict, signals: a.signals, before: ev.before, after: ev.after, replay: ev.replay };
      const suivant: WatchState = {
        ...w, servingVersionIds: serving, replays: (w.replays ?? 0) + (ev.replay ? 1 : 0), checks: (w.checks ?? 0) + 1, lastVerdict: a.verdict,
        lastCheckAt: now.toISOString(), lastSignals: signals, lastObservedAt: ev.after.calls > (((w.lastSignals as { after?: { calls?: number } } | undefined)?.after?.calls) ?? 0) ? now.toISOString() : w.lastObservedAt ?? null,
        milestones: { ...(w.milestones ?? {}) },
      };
      if (a.verdict !== w.lastVerdict || ev.replay) {
        await journal('POST_CHECK', a.verdict, `Contrôle post-activation de la candidate ${c.id} : ${a.verdict}${a.reasons.length ? ` — ${a.reasons.join(' ; ')}` : ''}`, signals as unknown as Record<string, unknown>, !a.rollback);
      }

      // 3. Régression démontrée et imputable → retour arrière CIBLÉ, sans attendre de jalon (MON-03, REC-078).
      if (a.rollback) {
        const motif = `dégradation imputable à la candidate ${c.id} : ${a.reasons.join(' ; ')}`.slice(0, 900);
        const svc = await import('../config/config-version.service');
        const r = await svc.rollbackPromotedTreatment(c.id, { reason: motif, evidence: signals as unknown as Record<string, unknown>, watch: suivant as unknown as Record<string, unknown>, now });
        if (r.status === 'ROLLED_BACK') sum.rolledBack += 1;
        else if (r.status === 'REPLACED') sum.replaced += 1;
        else sum.rollbackFailed += 1;
        continue;
      }

      // 4. Alertes non critiques dédupliquées (MON-04).
      if (a.verdict === 'ALERT') {
        const nouvelles = a.signals.filter((s) => s.outcome === 'ALERT' && !(w.alerts ?? []).includes(s.code));
        for (const s of nouvelles) {
          sum.alerts += 1;
          await journal('POST_ALERT', s.code, `Alerte post-activation (sans retour arrière : signal non éliminatoire seul) — ${s.label} : ${s.detail}`, { signal: s }, true);
        }
        suivant.alerts = [...new Set([...(w.alerts ?? []), ...nouvelles.map((s) => s.code)])];
      }

      // 5. État et jalons (jamais une clôture).
      suivant.status = nextWatchStatus({ verdict: a.verdict, afterCalls: ev.after.calls, minCallsValidated: minValidated, now, initialWindowEnd: suivant.initialWindowEnd, previous: w.status });
      if (suivant.status === 'VALIDATED_IN_USAGE' && !w.validatedAt) suivant.validatedAt = now.toISOString();
      if (now.getTime() >= Date.parse(suivant.initialWindowEnd) && !suivant.milestones!.h72) {
        suivant.milestones!.h72 = now.toISOString();
        await journal('WATCH_STATE', 'MILESTONE_72H', `Jalon 72 h de la candidate ${c.id} (${w.treatment}) : ${WATCH_STATUS_LABELS[suivant.status]}. Jalon d’observation, aucune clôture.`, { calls: ev.after.calls });
      }
      if (now.getTime() >= Date.parse(suivant.sevenDayReviewAt) && !suivant.milestones!.j7) {
        suivant.milestones!.j7 = now.toISOString();
        await journal('WATCH_STATE', 'REVIEW_J7', `Bilan J+7 de la candidate ${c.id} (${w.treatment}) : ${WATCH_STATUS_LABELS[suivant.status]}. Aucune décision par expiration (MON-01) : surveillance passive maintenue.`, { calls: ev.after.calls });
      }
      if (suivant.status !== w.status) {
        await journal('WATCH_STATE', suivant.status, `Candidate ${c.id} (${w.treatment}) : ${WATCH_STATUS_LABELS[w.status] ?? w.status} → ${WATCH_STATUS_LABELS[suivant.status]}.`, { calls: ev.after.calls, verdict: a.verdict });
      }
      if (suivant.status === 'VALIDATED_IN_USAGE') sum.validated += 1;
      if (suivant.status === 'INSUFFICIENT_USAGE') sum.insufficient += 1;
      if (suivant.status === 'OBSERVATION_UNAVAILABLE') sum.unavailable += 1;
      await enregistrer(suivant);
    }
    return sum;
  };
  if (p.skipLease) return travail();
  const { withJobLock } = await import('@/lib/job-lock');
  const r = await withJobLock(`ai-promotion-watch:${env}`, 2 * 3_600_000, travail);
  return r ?? { ...sum, skipped: 'surveillance déjà en cours sur une autre instance (bail partagé)' };
}
