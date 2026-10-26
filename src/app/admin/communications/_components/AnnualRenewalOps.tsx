'use client';

/**
 * Rappel J−7 des abonnements annuels — supervision et exploitation SANS SQL
 * (lot 68C, complété au lot 72F, ticket P1 « Fiabiliser le rappel J−7 »).
 *
 *   · état RÉEL des tâches (rappel, réconciliation) : suspendue, arrêtée par
 *     variable, dernier passage, compte rendu ;
 *   · bascule Stripe → Verebona : déclaration de la désactivation des rappels
 *     Stripe (sans elle : aucun rappel Verebona), début de couverture, retour
 *     arrière (neutralise les demandes en attente) ;
 *   · anomalies : vérifications Stripe en échec, couvertures incertaines,
 *     désynchronisations, acceptations Resend incertaines, demandes non
 *     traitées — avec les décisions possibles ;
 *   · échéances récentes et à venir, état distinct (préparé, en cours,
 *     accepté, livré, échec temporaire / définitif, incertain, annulé, exclu).
 *   · lot 76D : retour aux rappels Stripe EN PHASES — « en cours » tant qu'un
 *     appel Resend est en cours, à qualifier ou d'acceptation incertaine ;
 *     éléments à résoudre listés ; échéances déjà notifiées à arbitrer
 *     explicitement ; « terminé » seulement ensuite (réactivation Stripe).
 * Aucun lien ni client Stripe, aucun secret (l'API n'en sert pas). Mêmes
 * composants et jetons que la page ; tableaux défilants sur mobile, boutons
 * empilés sur petit écran.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

export interface SchedulerState {
  code: string; suspended: boolean; stoppedByEnv: boolean; lastStartedAt: string | null; lastFinishedAt: string | null;
  lastStatus: string | null; lastSuccessAt: string | null; lastNote: string | null; lastError: string | null; nextRunAt: string | null;
}
export interface AnnualRenewal {
  coverageFrom: string | null;
  jobs: Record<string, number>;
  checksToday: Array<{ outcome: string; reason: string | null; count: number }>;
  scheduler?: SchedulerState;
  reconcileScheduler?: SchedulerState;
  switch?: { declared: boolean; stripeRemindersDisabledAt: string | null; declaredAt: string | null; rollbackAt: string | null };
  lastReconcileAt?: string | null;
  lastReconcileNote?: string | null;
  recent?: Array<{ key: string; accountId: number | null; subscriptionId: string; renewalDate: string; state: string; step: string | null; reason: string | null; lastCheckedAt: string | null; nextCheckAt: string | null; jobId: number | null; attempts: number | null; nextAttemptAt: string | null; renewalDateVerified?: boolean }>;
  anomalies?: Array<{ state: string; key: string | null; jobId: number | null; accountId: number | null; renewalDate: string | null; reason: string | null; since: string | null; step?: string | null; nextAt?: string | null; renewalDateVerified?: boolean; neutralized?: boolean }>;
  /** Lot 76D : retour aux rappels Stripe. */
  rollback?: RollbackView | null;
}

interface RollbackBlocker { kind: 'IN_FLIGHT' | 'TO_RECONCILE' | 'UNCERTAIN' | 'NOTIFIED'; jobId: number | null; key: string | null; accountId: number | null; renewalDate: string | null; detail: string | null; since: string | null }
export interface RollbackView {
  status: 'in_progress' | 'completed'; startedAt: string | null; completedAt: string | null; completedBy: number | null; completionMode: 'auto' | 'admin_ack' | null;
  lastCheckAt: string | null; inFlight: number; toReconcile: number; uncertain: number; notified: number; neutralizedTotal: number; arbitratedUncertain: number;
  blockers: RollbackBlocker[];
}

/** Lot 76D : éléments empêchant la fin du retour arrière. */
const ROLLBACK_BLOCKER_LABELS: Record<RollbackBlocker['kind'], string> = {
  IN_FLIGHT: 'Appel Resend en cours (attendre)',
  TO_RECONCILE: 'Appel engagé à vérifier (contrôle automatique)',
  UNCERTAIN: 'Acceptation incertaine (décision requise)',
  NOTIFIED: 'Rappel Verebona déjà accepté (arbitrage)',
};

/** Statut d'une demande (file des e-mails). */
export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'préparé', sending: 'en cours d’envoi', accepted: 'accepté par Resend', failed: 'échoué', cancelled: 'annulé', uncertain: 'acceptation incertaine',
};

/** État consolidé d'une échéance (même liste que le service). */
export const REMINDER_STATE_LABELS: Record<string, string> = {
  WAITING: 'En attente du J−7', EXCLUDED: 'Exclu', NO_RECIPIENT: 'Sans destinataire', STRIPE_ERROR: 'Vérification Stripe en échec',
  COVERAGE_UNCERTAIN: 'Couverture incertaine (bascule)', DESYNC_RESYNCED: 'Resynchronisé depuis Stripe', DESYNC_UNRESOLVED: 'Désynchronisé (non résolu)',
  STRIPE_ONLY: 'Absent localement', PREPARED: 'Préparé', HELD: 'Retenu (suspension)', SENDING: 'En cours d’envoi', ACCEPTED: 'Accepté par Resend',
  DELIVERED: 'Livré', DELIVERY_PROBLEM: 'Problème de livraison', TEMPORARY_FAILURE: 'Échec temporaire', FINAL_FAILURE: 'Échec définitif',
  UNCERTAIN: 'Acceptation incertaine', CANCELLED: 'Annulé', OVERDUE: 'Demande non traitée',
  NEUTRALIZED: 'Neutralisé (retour aux rappels Stripe) — aucun envoi', CANCELLED_UNCERTAIN: 'Clos — envoi antérieur incertain (e-mail peut-être reçu)',
  RECONCILE_ERROR: 'Relecture Stripe en échec (réconciliation)', RECONCILE_RESOLVED: 'Relecture Stripe reprise',
};

/** Lot 76D : bloc « Retour aux rappels Stripe » (phase, éléments à résoudre, fin). */
function RollbackState({ r, post }: { r: RollbackView; post: (body: Record<string, unknown>, success: string) => Promise<void> }) {
  const [ack, setAck] = useState(false);
  const blocking = r.blockers.filter((b) => b.kind !== 'NOTIFIED').length;
  const notified = r.blockers.filter((b) => b.kind === 'NOTIFIED').length;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="annual-renewal-rollback-state">
      <p className="font-medium">
        Retour aux rappels Stripe :{' '}
        {r.status === 'in_progress'
          ? <span className={warn}>Retour arrière en cours — ne réactivez pas encore les rappels Stripe</span>
          : <span className={okc}>Retour arrière terminé le {when(r.completedAt)}{r.completionMode === 'admin_ack' ? ' (arbitrage BO)' : ' (automatique)'}</span>}
      </p>
      <p className="text-muted-foreground break-words">
        Commencé le {when(r.startedAt)} · dernier contrôle {when(r.lastCheckAt)} · neutralisées sans envoi {r.neutralizedTotal}
        {' '}· en cours {r.inFlight} · à vérifier {r.toReconcile} · acceptations incertaines {r.uncertain}
        {' '}· déjà notifiées {r.notified}{r.arbitratedUncertain ? ` · incertitudes closes par décision ${r.arbitratedUncertain}` : ''}
      </p>
      {r.status === 'in_progress' && r.blockers.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="annual-renewal-rollback-blockers">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-2 py-1 font-medium">Élément à résoudre</th><th className="px-2 py-1 font-medium">Demande</th>
                <th className="px-2 py-1 font-medium">Échéance</th><th className="px-2 py-1 font-medium">Compte</th>
                <th className="px-2 py-1 font-medium">Motif</th><th className="px-2 py-1 font-medium">Depuis</th>
              </tr>
            </thead>
            <tbody>
              {r.blockers.map((b) => (
                <tr key={`${b.kind}-${b.jobId ?? b.key ?? ''}`} className="border-t align-top">
                  <td className={`px-2 py-1 text-xs ${b.kind === 'NOTIFIED' ? warn : danger}`}>{ROLLBACK_BLOCKER_LABELS[b.kind]}</td>
                  <td className="px-2 py-1 text-xs tabular-nums">{b.jobId ?? '—'}</td>
                  <td className="px-2 py-1 text-xs">{b.renewalDate ?? '—'}</td>
                  <td className="px-2 py-1 text-xs tabular-nums">{b.accountId ?? 'aucun'}</td>
                  <td className="px-2 py-1 text-xs break-words">{b.detail ?? '—'}</td>
                  <td className="px-2 py-1 text-xs">{when(b.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {r.status === 'in_progress' ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button size="sm" variant="outline" data-testid="annual-renewal-rollback-check" onClick={() => post({ action: 'rollback-check' }, 'Contrôle du retour arrière effectué.')}>Vérifier maintenant</Button>
          {blocking > 0 ? (
            <span className="text-muted-foreground">Fin impossible : {blocking} élément(s) à résoudre (acceptations incertaines : décisions dans « À traiter »).</span>
          ) : (
            <>
              {notified > 0 ? (
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>{notified} échéance(s) ont déjà reçu le rappel Verebona : Stripe peut leur envoyer son propre rappel après réactivation (doublon possible, à assumer ou à prévenir).</span>
                </label>
              ) : null}
              <ConfirmButton testId="annual-renewal-rollback-finalize" label="Terminer le retour arrière" confirmLabel="Confirmer la fin"
                onConfirm={() => post({ action: 'rollback-finalize', acknowledgeNotified: ack }, 'Retour arrière terminé : vous pouvez réactiver les rappels dans Stripe.')} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

const danger = 'text-[color:var(--text-danger)]';
const warn = 'text-[color:var(--text-warning-soft)]';
const okc = 'text-[color:var(--text-success)]';
const shortSub = (id: string) => (id.length > 10 ? `…${id.slice(-8)}` : id);
const when = (v: string | null | undefined) => (v ? formatDateTime(v) : '—');

function TaskLine({ label, t }: { label: string; t?: SchedulerState }) {
  if (!t) return null;
  const etat = t.stoppedByEnv ? <span className={danger}>arrêtée (variable d’environnement)</span>
    : t.suspended ? <span className={warn}>suspendue</span> : <span className={okc}>active</span>;
  return (
    <p className="break-words">
      {label} (<span className="font-mono">{t.code}</span>) : {etat}
      {' '}· dernier passage {when(t.lastFinishedAt ?? t.lastStartedAt)}{t.lastStatus ? ` (${t.lastStatus === 'ok' ? 'réussi' : 'en échec'})` : ''}
      {' '}· prochain {t.suspended || t.stoppedByEnv ? '—' : when(t.nextRunAt)}
      {t.lastError ? <span className={`block ${danger}`}>{t.lastError}</span> : null}
      {t.lastNote ? <span className="block text-muted-foreground">{t.lastNote}</span> : null}
    </p>
  );
}

/** Bouton à confirmation en deux temps (action journalisée). */
function ConfirmButton({ label, confirmLabel, onConfirm, variant = 'outline', testId }: { label: string; confirmLabel: string; onConfirm: () => Promise<void>; variant?: 'outline' | 'default' | 'ghost'; testId?: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!armed) return <Button size="sm" variant={variant} onClick={() => setArmed(true)} data-testid={testId}>{label}</Button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setArmed(false); } }}>
        {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}{confirmLabel}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>Annuler</Button>
    </span>
  );
}

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function AnnualRenewalOps({ a, onChanged }: { a: AnnualRenewal; onChanged: () => void }) {
  const [disabledAt, setDisabledAt] = useState(nowLocal());
  const post = async (body: Record<string, unknown>, success: string) => {
    try {
      await apiClient.post('/api/admin/communications/annual-renewal', body);
      toast.success(success);
      onChanged();
    } catch (e) {
      toast.error((e as { serverMessage?: string })?.serverMessage ?? 'Opération refusée.');
    }
  };
  const jobs = Object.entries(a.jobs);
  const sw = a.switch;
  return (
    <div className="text-xs space-y-3" data-testid="annual-renewal-overview">
      <p className="font-medium text-sm">Rappel J−7 des abonnements annuels</p>
      <div className="space-y-1">
        <TaskLine label="Tâche du rappel" t={a.scheduler} />
        <TaskLine label="Réconciliation avec Stripe" t={a.reconcileScheduler} />
        <p>
          Dernière réconciliation : {when(a.lastReconcileAt)}{a.lastReconcileNote ? ` — ${a.lastReconcileNote}` : ''}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border p-3" data-testid="annual-renewal-switch">
        <p className="font-medium">Bascule des rappels Stripe vers Verebona</p>
        {sw?.declared ? (
          <p>
            <span className={okc}>Rappels Stripe déclarés désactivés</span> le {when(sw.stripeRemindersDisabledAt)} (déclaré le {when(sw.declaredAt)})
            {' '}· couverture Verebona des J−7 à partir du <span className="font-medium">{a.coverageFrom ?? '—'}</span>
          </p>
        ) : (
          <p className={warn}>
            Bascule non déclarée : aucun NOUVEL envoi de rappel Verebona{sw?.rollbackAt ? ` (retour aux rappels Stripe le ${when(sw.rollbackAt)})` : ''}.
          </p>
        )}
        {a.rollback ? <RollbackState r={a.rollback} post={post} /> : null}
        {!sw?.declared && a.rollback?.status !== 'in_progress' ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Désactivation effectuée dans Stripe le</span>
              <Input type="datetime-local" className="w-full sm:w-56" value={disabledAt} onChange={(e) => setDisabledAt(e.target.value)} aria-label="Date et heure de désactivation des rappels Stripe" />
            </label>
            <ConfirmButton testId="annual-renewal-declare" label="Déclarer la désactivation des rappels Stripe" confirmLabel="Confirmer (rappels Stripe désactivés)"
              onConfirm={() => post({ action: 'declare', disabledAt: new Date(disabledAt).toISOString() }, 'Bascule déclarée.')} />
          </div>
        ) : sw?.declared ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <ConfirmButton testId="annual-renewal-rollback" label="Revenir aux rappels Stripe" confirmLabel="Confirmer le retour arrière"
              onConfirm={() => post({ action: 'rollback' }, 'Retour arrière en cours : attendez « Retour arrière terminé » avant de réactiver les rappels dans Stripe.')} />
            <span className="text-muted-foreground">Suspendez d’abord la tâche (Exploitation › Tâches planifiées). Réactivez les rappels dans Stripe seulement quand le bloc affiche « Retour arrière terminé ».</span>
          </div>
        ) : null}
      </div>

      <p>Demandes (30 j) : {jobs.length ? jobs.map(([k, n]) => `${JOB_STATUS_LABELS[k] ?? k} ${n}`).join(', ') : 'aucune'}</p>
      {a.checksToday.length > 0 && (
        <p>Décisions du jour : {a.checksToday.map((c) => `${c.outcome}${c.reason ? ` (${c.reason})` : ''} ${c.count}`).join(', ')}</p>
      )}

      {(a.anomalies?.length ?? 0) > 0 && (
        <div className="space-y-1" data-testid="annual-renewal-anomalies">
          <p className={`font-medium ${danger}`}>À traiter : erreurs, demandes non traitées, états incertains ({a.anomalies!.length})</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">État</th><th className="px-2 py-1 font-medium">Échéance</th>
                  <th className="px-2 py-1 font-medium">Compte</th><th className="px-2 py-1 font-medium">Motif</th>
                  <th className="px-2 py-1 font-medium">Depuis</th><th className="px-2 py-1 font-medium">Décision</th>
                </tr>
              </thead>
              <tbody>
                {a.anomalies!.map((x) => (
                  <tr key={`${x.state}-${x.key ?? ''}-${x.jobId ?? ''}`} className="border-t align-top">
                    <td className={`px-2 py-1 text-xs ${danger}`}>{REMINDER_STATE_LABELS[x.state] ?? x.state}</td>
                    <td className="px-2 py-1 text-xs">{x.renewalDate ?? '—'}</td>
                    <td className="px-2 py-1 text-xs tabular-nums">{x.accountId ?? 'aucun'}</td>
                    <td className="px-2 py-1 text-xs break-words">{x.reason ?? '—'}</td>
                    <td className="px-2 py-1 text-xs">
                      {when(x.since)}
                      {x.nextAt ? <span className="block text-muted-foreground">prochaine tentative {when(x.nextAt)}</span> : null}
                      {x.renewalDateVerified === false ? <span className="block text-muted-foreground">échéance locale non revérifiée</span> : null}
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap">
                        {x.state === 'COVERAGE_UNCERTAIN' && x.key ? (
                          <>
                            <ConfirmButton label="Rappel Stripe constaté" confirmLabel="Confirmer" onConfirm={() => post({ action: 'coverage', key: x.key, decision: 'STRIPE_CONFIRMED' }, 'Échéance close : rappel Stripe constaté.')} />
                            <ConfirmButton label="Envoyer le rappel Verebona" confirmLabel="Confirmer l’envoi" onConfirm={() => post({ action: 'coverage', key: x.key, decision: 'SEND_VEREBONA' }, 'Rappel Verebona préparé.')} />
                          </>
                        ) : null}
                        {x.state === 'UNCERTAIN' && x.jobId ? (
                          <>
                            <ConfirmButton label="Vérifier de nouveau" confirmLabel="Confirmer" onConfirm={() => post({ action: 'job', jobId: x.jobId, decision: 'RECHECK' }, 'Nouvelle réconciliation programmée.')} />
                            <ConfirmButton label="Trouvé chez Resend" confirmLabel="Confirmer : envoyé" onConfirm={() => post({ action: 'job', jobId: x.jobId, decision: 'CONFIRM_SENT' }, 'Demande close comme acceptée.')} />
                            {x.neutralized ? (
                              <span className="text-xs text-muted-foreground">neutralisée (retour aux rappels Stripe) : aucune réémission</span>
                            ) : (
                              <ConfirmButton label="Absent chez Resend : réémettre" confirmLabel="Confirmer la réémission" onConfirm={() => post({ action: 'job', jobId: x.jobId, decision: 'REISSUE' }, 'Réémission programmée (nouvelle clé).')} />
                            )}
                            <ConfirmButton variant="ghost" label="Abandonner" confirmLabel="Confirmer l’abandon" onConfirm={() => post({ action: 'job', jobId: x.jobId, decision: 'ABANDON' }, 'Demande abandonnée.')} />
                          </>
                        ) : null}
                        {x.state !== 'COVERAGE_UNCERTAIN' && x.state !== 'UNCERTAIN' ? <span className="text-xs text-muted-foreground">voir docs/exploitation/rappel-renouvellement-annuel.md</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(a.recent?.length ?? 0) > 0 && (
        <details className="space-y-1">
          <summary className="cursor-pointer font-medium">Échéances récentes et à venir ({a.recent!.length})</summary>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="annual-renewal-recent">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Échéance</th><th className="px-2 py-1 font-medium">Compte</th>
                  <th className="px-2 py-1 font-medium">Abonnement</th><th className="px-2 py-1 font-medium">État</th>
                  <th className="px-2 py-1 font-medium">Étape · motif</th><th className="px-2 py-1 font-medium">Dernier contrôle</th>
                  <th className="px-2 py-1 font-medium">Prochaine</th>
                </tr>
              </thead>
              <tbody>
                {a.recent!.map((r) => (
                  <tr key={r.key} className="border-t align-top">
                    <td className="px-2 py-1 text-xs">{r.renewalDate}</td>
                    <td className="px-2 py-1 text-xs tabular-nums">{r.accountId ?? 'aucun'}</td>
                    <td className="px-2 py-1 text-xs font-mono">{shortSub(r.subscriptionId)}</td>
                    <td className="px-2 py-1 text-xs">{REMINDER_STATE_LABELS[r.state] ?? r.state}{r.jobId ? ` · n° ${r.jobId}` : ''}{r.attempts ? ` · ${r.attempts} tentative(s)` : ''}</td>
                    <td className="px-2 py-1 text-xs break-words">{[r.step, r.reason].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-2 py-1 text-xs">{when(r.lastCheckedAt)}</td>
                    <td className="px-2 py-1 text-xs">{when(r.nextAttemptAt ?? r.nextCheckAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
