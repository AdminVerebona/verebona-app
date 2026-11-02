/**
 * Lot 105B — SURVEILLANCE des candidates de configuration activées
 * automatiquement (campagne 86A) — tâche planifiée `ai-promotion-watch`
 * (toutes les heures, préproduction seulement ; production : sans objet).
 *
 * Pour chaque candidate ACTIVÉE dont la fenêtre de surveillance est ouverte :
 *   · remplacée entre-temps (choix humain, autre activation) → fin de
 *     surveillance, rien n'est imputé, aucun retour arrière ;
 *   · signaux métier vérifiables (`post-activation.ts`) : contrôles serveur,
 *     disponibilité, latence / coût (alerte), cas certifiés rejoués ;
 *   · dégradation IMPUTABLE démontrée → RETOUR ARRIÈRE ATOMIQUE à la
 *     configuration précédente (une transaction, sous le verrou de
 *     l'environnement, seulement si la candidate est toujours l'active),
 *     candidate SUSPENDUE, caches invalidés, journal ; l'ancienne version
 *     reste disponible et la candidate consultable ;
 *   · fin de fenêtre sans dégradation → résolue (données insuffisantes dites
 *     telles, jamais présentées comme une preuve de qualité).
 * Idempotent (état dans `candidate_promotion.watch`, bail partagé), borné
 * (un rejeu au plus par activation), aucun effet externe.
 */
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';
import { evaluatePostActivation, type PostVerdict } from './post-activation';
import { recordPromotionEvent } from './promotion-journal';
import type { CampaignDeps } from './campaign';

export interface WatchSummary {
  environment: string;
  watched: number;
  rolledBack: number;
  alerts: number;
  resolved: number;
  replaced: number;
  replays: number;
  skipped?: string;
}

interface WatchState {
  status: 'WATCHING' | 'RESOLVED' | 'ROLLED_BACK' | 'ROLLBACK_FAILED' | 'REPLACED';
  activatedAt: string; watchUntil: string; previousVersionId: number | null; treatment: Treatment; operations: string[]; campaignId: number | null;
  replays: number; alerts: string[]; checks: number; lastVerdict?: PostVerdict; lastCheckAt?: string; lastSignals?: unknown; endedAt?: string; endReason?: string;
}

export async function runPromotionWatch(p: { trigger: string; now?: () => Date; environment?: AiEnvironment; campaign?: CampaignDeps; skipLease?: boolean } = { trigger: 'manual' }): Promise<WatchSummary> {
  const env = p.environment ?? getAiEnvironment();
  const sum: WatchSummary = { environment: env, watched: 0, rolledBack: 0, alerts: 0, resolved: 0, replaced: 0, replays: 0 };
  if (env === 'production') return { ...sum, skipped: 'production : aucune activation automatique, rien à surveiller (R9)' };
  const travail = async () => {
    const cfg = await import('../config/config-version.repository');
    const now = (p.now ?? (() => new Date()))();
    const actives = (await cfg.listCandidates(env, ['ACTIVATED'])).filter((c) => (c.promotion.watch as WatchState | undefined)?.status === 'WATCHING');
    const active = await cfg.getActiveVersion(env).catch(() => null);
    for (const c of actives) {
      const w = c.promotion.watch as WatchState;
      sum.watched += 1;
      const fin = async (status: WatchState['status'], endReason: string, extra: Partial<WatchState> = {}) => {
        await cfg.mergeCandidatePromotion(c.id, { watch: { ...w, ...extra, status, endedAt: now.toISOString(), endReason } });
        await recordPromotionEvent({ environment: env, kind: status === 'ROLLED_BACK' ? 'ROLLBACK' : status === 'ROLLBACK_FAILED' ? 'ROLLBACK_FAILED' : 'WATCH_END', candidateVersionId: c.id, campaignId: w.campaignId, treatment: w.treatment, allowed: null, code: status, message: endReason.slice(0, 2000), reference: { previousVersionId: w.previousVersionId, ...(extra.lastSignals ? { signals: extra.lastSignals } : {}) } });
      };
      const candidateActive = active?.id === c.id;
      if (!candidateActive) {
        sum.replaced += 1;
        await fin('REPLACED', `Candidate ${c.id} n’est plus la configuration active (configuration ${active?.id ?? '—'}) : choix respecté, surveillance arrêtée, rien n’est imputé.`);
        continue;
      }
      const ev = await evaluatePostActivation({
        treatment: w.treatment, operations: w.operations, candidateVersionId: c.id, previousVersionId: w.previousVersionId,
        activatedAt: new Date(w.activatedAt), now, replaysDone: w.replays ?? 0, candidateActive,
        replay: async (x) => (await import('./campaign')).requestPostActivationReplay(x, p.campaign ?? {}),
      });
      const a = ev.assessment;
      const replays = (w.replays ?? 0) + (ev.replay ? 1 : 0);
      if (ev.replay) sum.replays += 1;
      const signals = { verdict: a.verdict, signals: a.signals, before: ev.before, after: ev.after, replay: ev.replay };
      const suivant: WatchState = { ...w, replays, checks: (w.checks ?? 0) + 1, lastVerdict: a.verdict, lastCheckAt: now.toISOString(), lastSignals: signals };
      if (a.verdict !== w.lastVerdict || ev.replay) {
        await recordPromotionEvent({ environment: env, kind: 'POST_CHECK', candidateVersionId: c.id, campaignId: ev.replay?.campaignId ?? w.campaignId, treatment: w.treatment, allowed: !a.rollback, code: a.verdict,
          message: `Contrôle post-activation de la candidate ${c.id} : ${a.verdict}${a.reasons.length ? ` — ${a.reasons.join(' ; ')}` : ''}`.slice(0, 2000), reference: signals as unknown as Record<string, unknown> });
      }
      if (a.rollback) {
        const motif = `dégradation imputable à la candidate ${c.id} : ${a.reasons.join(' ; ')}`.slice(0, 900);
        const r = await rollbackCandidate(c.id, w, env, motif);
        if (r.ok) { sum.rolledBack += 1; await fin('ROLLED_BACK', `Retour arrière automatique vers la configuration ${w.previousVersionId} : ${motif}`, suivant); }
        else await fin('ROLLBACK_FAILED', `Dégradation imputable démontrée mais retour arrière impossible (${r.error}) : réactiver la configuration ${w.previousVersionId ?? 'précédente'} à la main (BO › Configuration IA).`, suivant);
        continue;
      }
      if (a.verdict === 'ALERT') {
        const nouvelles = a.signals.filter((s) => s.outcome === 'ALERT' && !(w.alerts ?? []).includes(s.code));
        for (const s of nouvelles) {
          sum.alerts += 1;
          await recordPromotionEvent({ environment: env, kind: 'POST_ALERT', candidateVersionId: c.id, campaignId: w.campaignId, treatment: w.treatment, allowed: true, code: s.code,
            message: `Alerte post-activation (sans retour arrière : signal non éliminatoire seul) — ${s.label} : ${s.detail}`.slice(0, 2000), reference: { signal: s } });
        }
        suivant.alerts = [...new Set([...(w.alerts ?? []), ...nouvelles.map((s) => s.code)])];
      }
      if (now.getTime() >= Date.parse(w.watchUntil)) {
        sum.resolved += 1;
        await fin('RESOLVED', a.verdict === 'INSUFFICIENT_DATA'
          ? `Fenêtre de surveillance écoulée : données insuffisantes pour conclure (aucun retour arrière, aucune preuve de qualité supplémentaire).`
          : `Fenêtre de surveillance écoulée sans dégradation imputable (${a.verdict}).`, suivant);
        continue;
      }
      await cfg.mergeCandidatePromotion(c.id, { watch: suivant });
    }
    return sum;
  };
  if (p.skipLease) return travail();
  const { withJobLock } = await import('@/lib/job-lock');
  const r = await withJobLock(`ai-promotion-watch:${env}`, 2 * 3_600_000, travail);
  return r ?? { ...sum, skipped: 'surveillance déjà en cours sur une autre instance (bail partagé)' };
}

/**
 * Retour arrière ATOMIQUE : la configuration précédente est réactivée dans UNE transaction, sous le verrou de
 * l'environnement, seulement si la candidate est toujours l'active (sinon rien : un humain a déjà agi).
 */
async function rollbackCandidate(versionId: number, w: WatchState, env: string, motif: string): Promise<{ ok: boolean; error?: string }> {
  if (!w.previousVersionId) return { ok: false, error: 'aucune configuration précédente connue' };
  const cfg = await import('../config/config-version.repository');
  try {
    const r = await cfg.activateVersion(w.previousVersionId, null, undefined, {
      summary: `Retour arrière automatique (surveillance post-activation) : ${motif}`.slice(0, 300),
      guard: async (sql) => {
        const rows = (await sql.unsafe(`SELECT id FROM ai_config_versions WHERE environment = $1 AND status = 'ACTIVE'`, [env] as never[])) as Array<{ id: number }>;
        if (!rows.some((x) => Number(x.id) === versionId)) throw new Error('la candidate n’est plus la configuration active : retour arrière non nécessaire');
      },
    });
    const { afterCommit } = await import('../config/config-version.service');
    await afterCommit(`rollback-promotion:${w.previousVersionId}`, r.masterPromptSwitches);
    await cfg.suspendCandidate(versionId, `Retour arrière automatique : ${motif}`);
    const [{ invalidateConfigCache }, { invalidateConfigVersionCache }] = await Promise.all([import('../config/config-resolver'), import('../telemetry/execution-context')]);
    invalidateConfigCache();
    invalidateConfigVersionCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}
