"use client";

/**
 * Écran générique de traitement d'une anomalie — CDC BO SUP-006, SUP-007.
 *
 * Affiche : détail technique, domaine, compte / utilisateur concernés, cause,
 * commentaire interne, action corrective et « Marquer résolue ». S'y ajoutent
 * les occurrences consolidées (SUP-010), le lien de récurrence (SUP-011), la
 * résolution automatique le cas échéant (SUP-008) et, pour l'IA, le lien vers
 * l'écran IA pertinent (AI-001).
 *
 * « Marquer résolue » exige une confirmation explicite et l'action
 * corrective (bouton désactivé avec motif sinon, UX-003) ; le bouton est
 * verrouillé pendant l'envoi (ERR-002) et l'écran est relu depuis le serveur
 * après chaque action (ERR-003).
 */
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDateTime } from '@/lib/admin/format';
import type { AnomalyDetail } from '@/services/admin/anomaly.service';

const AUTO_ORIGIN_LABEL: Record<string, string> = {
  stripe_webhook_retry: 'Relance du webhook Stripe traitée avec succès',
  notification_delivered: 'Notification du même type délivrée sur ce canal',
  backup_succeeded: 'Sauvegarde réussie',
  backup_freshness_check: 'Sauvegarde récente constatée',
  referral_reward_cron: 'Récompense attribuée lors d\'un passage ultérieur',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default function AnomalyTreatmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [anomaly, setAnomaly] = useState<AnomalyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState({ cause: '', internalComment: '', correctiveAction: '' });
  const [busy, setBusy] = useState<'save' | 'resolve' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const apply = (a: AnomalyDetail) => {
    setAnomaly(a);
    setNotes({ cause: a.cause ?? '', internalComment: a.internalComment ?? '', correctiveAction: a.correctiveAction ?? '' });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/anomalies/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) { router.push(`/login?returnUrl=/admin/supervision/${id}`); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `Erreur ${res.status}`); setAnomaly(null); return; }
      apply(body.anomaly);
    } catch {
      setError('Erreur réseau — impossible de charger l\'anomalie.');
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { void load(); }, [load]);

  const send = async (kind: 'save' | 'resolve') => {
    if (busy) return;
    setBusy(kind);
    setActionError(null);
    setMessage(null);
    try {
      const res = await fetch(
        kind === 'save' ? `/api/admin/anomalies/${id}` : `/api/admin/anomalies/${id}/resolve`,
        {
          method: kind === 'save' ? 'PATCH' : 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notes),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(body.error || `Erreur ${res.status}`);
        await load(); // ERR-003 : l'état a pu changer (résolue ailleurs).
        return;
      }
      apply(body.anomaly);
      setMessage(kind === 'save' ? 'Enregistré.' : 'Anomalie marquée résolue.');
    } catch {
      setActionError('Erreur réseau — action non confirmée. Rechargez la page pour vérifier l\'état.');
    } finally {
      setBusy(null);
      setConfirmOpen(false);
    }
  };

  const back = (
    <Link href="/admin?tab=supervision" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> Supervision
    </Link>
  );

  if (loading && !anomaly) {
    return <div className="space-y-4">{back}<div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div></div>;
  }
  if (error || !anomaly) {
    return <div className="space-y-4">{back}<EcranEnErreur titre="Anomalie indisponible" message={error} onRetry={load} /></div>;
  }

  const open = anomaly.status === 'open';
  const canResolve = notes.correctiveAction.trim().length > 0;

  return (
    <div className="space-y-6 max-w-5xl">
      {back}
      <div>
        <p className="text-xs text-muted-foreground">{anomaly.domainLabel} · anomalie #{anomaly.id}</p>
        <h1 className="text-2xl font-bold">{anomaly.title}</h1>
        <p className={`text-sm mt-1 ${open ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {open
            ? 'Ouverte'
            : `Résolue le ${formatDateTime(anomaly.resolvedAt)} — ${anomaly.resolutionSource === 'auto' ? 'automatiquement' : `manuellement${anomaly.resolvedByEmail ? ` par ${anomaly.resolvedByEmail}` : ''}`}`}
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Field label="Domaine">{anomaly.domainLabel}</Field>
        <Field label="Compte concerné">
          {anomaly.accountId ? <Link className="hover:underline" href={`/admin/accounts/${anomaly.accountId}`}>{anomaly.accountName ?? `#${anomaly.accountId}`}</Link> : 'Non applicable'}
        </Field>
        <Field label="Utilisateur concerné">
          {anomaly.userId ? <Link className="hover:underline" href={`/admin/users/${anomaly.userId}`}>{anomaly.userEmail ?? `#${anomaly.userId}`}</Link> : 'Non applicable'}
        </Field>
        <Field label="Première occurrence">{formatDateTime(anomaly.firstSeenAt)}</Field>
        <Field label="Dernière occurrence">{formatDateTime(anomaly.lastSeenAt)}</Field>
        <Field label="Occurrences">{anomaly.occurrenceCount}</Field>
        {anomaly.previous && (
          <Field label="Récurrence de">
            <Link className="hover:underline" href={`/admin/supervision/${anomaly.previous.id}`}>
              #{anomaly.previous.id}, résolue le {formatDateTime(anomaly.previous.resolvedAt)}
            </Link>
          </Field>
        )}
        {anomaly.recurrence && (
          <Field label="A réapparu">
            <Link className="hover:underline" href={`/admin/supervision/${anomaly.recurrence.id}`}>
              #{anomaly.recurrence.id} le {formatDateTime(anomaly.recurrence.firstSeenAt)}
            </Link>
          </Field>
        )}
        {anomaly.resolutionSource === 'auto' && (
          <Field label="Résolution automatique">
            {AUTO_ORIGIN_LABEL[anomaly.autoResolutionOrigin ?? ''] ?? anomaly.autoResolutionOrigin ?? '—'}
            {anomaly.autoResolutionCause && <span className="block text-muted-foreground">Cause : {anomaly.autoResolutionCause}</span>}
          </Field>
        )}
        {anomaly.diagnosticLink && (
          <Field label="Diagnostic">
            <Link className="inline-flex items-center gap-1 hover:underline" href={anomaly.diagnosticLink.href}>
              {anomaly.diagnosticLink.label} <ExternalLink className="h-3 w-3" />
            </Link>
          </Field>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-2">
        <p className="text-sm font-medium">Détail technique (dernière occurrence)</p>
        <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all">
          {anomaly.technicalDetail ? JSON.stringify(anomaly.technicalDetail, null, 2) : '—'}
        </pre>
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-4">
        <p className="text-sm font-medium">Traitement</p>
        {(['cause', 'internalComment', 'correctiveAction'] as const).map((k) => (
          <div key={k} className="space-y-1">
            <label htmlFor={k} className="text-xs text-muted-foreground">
              {{ cause: 'Cause', internalComment: 'Commentaire interne', correctiveAction: 'Action corrective' }[k]}
              {k === 'correctiveAction' && open && ' (requise pour marquer résolue)'}
            </label>
            {open ? (
              <Textarea id={k} rows={3} value={notes[k]} maxLength={4000}
                onChange={(e) => setNotes((n) => ({ ...n, [k]: e.target.value }))} />
            ) : (
              <p id={k} className="text-sm whitespace-pre-wrap">{notes[k] || '—'}</p>
            )}
          </div>
        ))}
        {actionError && <p className="text-sm text-red-600 dark:text-red-400">{actionError}</p>}
        {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
        {open && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => send('save')} disabled={busy !== null}>
              {busy === 'save' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Enregistrer
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={busy !== null || !canResolve}
              title={canResolve ? undefined : 'Renseignez l\'action corrective pour pouvoir marquer l\'anomalie résolue'}
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" /> Marquer résolue
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <p className="text-sm font-medium px-4 pt-4">Historique des occurrences</p>
        <table className="w-full text-sm mt-2">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Compte</th>
              <th className="px-4 py-2 font-medium">Utilisateur</th>
              <th className="px-4 py-2 font-medium">Détail</th>
            </tr>
          </thead>
          <tbody>
            {anomaly.occurrences.map((o) => (
              <tr key={o.id} className="border-b last:border-b-0 align-top">
                <td className="px-4 py-2 whitespace-nowrap">{formatDateTime(o.occurredAt)}</td>
                <td className="px-4 py-2">{o.accountId ? <Link className="hover:underline" href={`/admin/accounts/${o.accountId}`}>#{o.accountId}</Link> : '—'}</td>
                <td className="px-4 py-2">{o.userId ? <Link className="hover:underline" href={`/admin/users/${o.userId}`}>#{o.userId}</Link> : '—'}</td>
                <td className="px-4 py-2 font-mono text-xs break-all">{o.technicalDetail ? JSON.stringify(o.technicalDetail) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {anomaly.occurrenceCount > anomaly.occurrences.length && (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {anomaly.occurrences.length} occurrences les plus récentes affichées sur {anomaly.occurrenceCount}.
          </p>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !busy && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marquer cette anomalie résolue ?</AlertDialogTitle>
            <AlertDialogDescription>
              Elle passera dans l&apos;historique avec la cause et l&apos;action corrective saisies, qui ne seront plus modifiables.
              Si le problème réapparaît, une nouvelle anomalie liée à celle-ci sera créée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={busy !== null} onClick={(e) => { e.preventDefault(); void send('resolve'); }}>
              {busy === 'resolve' && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Marquer résolue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
