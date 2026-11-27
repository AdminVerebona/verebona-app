"use client";

/**
 * Fiche Compte (BO) — « Compte de revue des stores » (carte #876).
 *
 * Qualification technique explicite, INDÉPENDANTE de l'offre : « Compte
 * client » (défaut), « Compte de revue Apple », « Compte de revue Google » ;
 * identités autorisées à l'exemption de l'obligation GLOBALE de double
 * authentification ; droits de démonstration Premium Duo ; historique.
 *
 * Lecture : tout administrateur. Modification : SUPER_ADMIN connecté avec la
 * double authentification, réauthentification forte à chaque opération
 * (`ReauthProvider`, fenêtre unique de l'application), motif et phrase de
 * confirmation. Toutes ces règles sont VÉRIFIÉES PAR LE SERVEUR
 * (`/api/admin/accounts/[id]/app-review`) : l'interface ne décide de rien.
 * Aucun identifiant ni mot de passe n'est saisi ou affiché ici.
 */
import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReauthProvider, useReauth } from '@/components/account/security/ReauthProvider';
import { formatDateTime } from '@/lib/admin/format';

type Kind = 'APPLE' | 'GOOGLE';
type Action = 'qualify' | 'unqualify' | 'grant' | 'revoke' | 'demo_rights';

interface AppReviewUser {
  id: number; email: string; firstName: string | null; role: string; status: string; access: string; mfaEnrolled: boolean;
  exemption: { id: number; accountId: number; grantedAt: string; grantedBy: number | null; reason: string } | null;
  effective: boolean; diagnostic: string | null;
}
interface AppReviewPayload {
  account: { id: number; name: string; kind: Kind | null; kindLabel: string; technical: boolean; billed: boolean; planType: string; subscriptionStatus: string; rights: { planCode: string | null; status: string | null } };
  users: AppReviewUser[];
  exemptions: Array<{ id: number; userId: number; email: string | null; grantedAt: string; grantedReason: string; revokedAt: string | null; revokedReason: string | null }>;
  events: Array<{ id: number; event: string; userId: number | null; kind: string | null; reason: string | null; actorEmail: string | null; createdAt: string }>;
  mfaEnforcement: { users: boolean };
  viewer: { role: string | null; canManage: boolean; strongSession: boolean };
  confirmation: string;
  reasonMinLength: number;
}

const EVENT_LABELS: Record<string, string> = {
  ACCOUNT_QUALIFIED: 'Compte qualifié compte de revue',
  ACCOUNT_UNQUALIFIED: 'Retour à « Compte client »',
  EXEMPTION_GRANTED: 'Exemption MFA autorisée',
  EXEMPTION_REVOKED: 'Exemption MFA révoquée',
  DEMO_RIGHTS_GRANTED: 'Droits de démonstration Premium Duo',
};

const ACTION_LABELS: Record<Action, string> = {
  qualify: 'Qualifier le compte',
  unqualify: 'Revenir à « Compte client »',
  grant: 'Autoriser l’exemption',
  revoke: 'Révoquer l’exemption',
  demo_rights: 'Attribuer les droits de démonstration Premium Duo',
};

export function AccountAppReview({ accountId }: { accountId: string | number }) {
  return (
    <ReauthProvider>
      <AccountAppReviewInner accountId={accountId} />
    </ReauthProvider>
  );
}

function AccountAppReviewInner({ accountId }: { accountId: string | number }) {
  const { withReauth } = useReauth();
  const [data, setData] = useState<AppReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: Action; userId?: number; kind?: Kind } | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiClient.get<AppReviewPayload>(`/api/admin/accounts/${accountId}/app-review`));
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  const start = (p: { action: Action; userId?: number; kind?: Kind }) => { setPending(p); setReason(''); setConfirm(''); };

  const submit = async () => {
    if (!pending || !data) return;
    setSubmitting(true);
    try {
      const res = await withReauth(
        () => apiClient.post<{ success: boolean; warning?: string; sessionsRevoked?: number }>(
          `/api/admin/accounts/${accountId}/app-review`,
          { action: pending.action, kind: pending.kind, userId: pending.userId, reason, confirm },
        ),
        'Opération réservée au SUPER_ADMIN : confirmez votre identité avec une clé d’accès ou l’application d’authentification.',
      );
      toast.success(`${ACTION_LABELS[pending.action]} : fait.${res.sessionsRevoked ? ` Sessions révoquées : ${res.sessionsRevoked}.` : ''}`);
      if (res.warning) toast.warning(res.warning);
      setPending(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Opération impossible.');
    } finally {
      setSubmitting(false);
    }
  };

  const a = data?.account;
  const can = !!data?.viewer.canManage;
  return (
    <section className="rounded-xl border bg-card overflow-hidden" data-testid="bo-account-app-review">
      <div className="px-5 py-4 border-b">
        <h2 className="vb-app-section flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          Compte de revue des stores (Apple / Google)
        </h2>
      </div>
      {error ? (
        <div className="px-5 py-4 text-sm text-[color:var(--text-danger)]">
          {error}{' '}
          <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
        </div>
      ) : !data || !a ? (
        <p className="px-5 py-4 text-xs text-muted-foreground">Chargement…</p>
      ) : (
        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="space-y-1">
            <p>Qualification technique : <strong data-testid="bo-app-review-kind">{a.kindLabel}</strong> <span className="text-xs text-muted-foreground">(indépendante de l’offre)</span></p>
            <p className="text-xs text-muted-foreground">
              Obligation globale de double authentification : {data.mfaEnforcement.users ? 'en vigueur' : 'non activée'}.
              L’exemption ne neutralise que cette obligation : un facteur déjà enrôlé reste exigé, la session reste de niveau 1.
            </p>
            {!can && (
              <p className="text-xs text-muted-foreground" data-testid="bo-app-review-readonly">
                {data.viewer.role !== 'SUPER_ADMIN'
                  ? 'Consultation seule : modifications réservées au rôle SUPER_ADMIN.'
                  : 'Consultation seule : reconnectez-vous avec la double authentification pour modifier.'}
              </p>
            )}
          </div>

          {can && (
            <div className="flex flex-wrap gap-2">
              {!a.kind ? (
                <>
                  <Button size="sm" variant="outline" disabled={a.billed || a.technical} onClick={() => start({ action: 'qualify', kind: 'APPLE' })}>Qualifier « Compte de revue Apple »</Button>
                  <Button size="sm" variant="outline" disabled={a.billed || a.technical} onClick={() => start({ action: 'qualify', kind: 'GOOGLE' })}>Qualifier « Compte de revue Google »</Button>
                  {(a.billed || a.technical) && <p className="text-xs text-muted-foreground w-full">{a.billed ? 'Compte facturé (Stripe) : il ne peut pas devenir un compte de revue.' : 'Compte technique : non qualifiable.'}</p>}
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" disabled={a.billed} onClick={() => start({ action: 'demo_rights' })}>Droits de démonstration Premium Duo</Button>
                  <Button size="sm" variant="outline" onClick={() => start({ action: 'unqualify' })}>Revenir à « Compte client »</Button>
                </>
              )}
            </div>
          )}
          {a.kind && (
            <p className="text-xs text-muted-foreground">
              Droits effectifs : offre {a.planType}, abonnement {a.rights.planCode ?? '—'} / {a.rights.status ?? '—'}.
            </p>
          )}

          {a.kind && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">Identités du compte</h3>
              <ul className="divide-y rounded-lg border">
                {data.users.map((u) => (
                  <li key={u.id} className="px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" data-testid={`bo-app-review-user-${u.id}`}>
                    <div className="text-xs space-y-0.5">
                      <p className="text-sm">{u.firstName || u.email} <span className="text-muted-foreground">#{u.id} · {u.access} · {u.role} · {u.status}</span></p>
                      <p className="text-muted-foreground">
                        {u.exemption
                          ? (u.effective ? 'Exemption active et effective.' : `Exemption autorisée, non effective : ${u.diagnostic ?? 'obligation globale non en vigueur.'}`)
                          : 'Aucune exemption (règle MFA normale).'}
                        {u.mfaEnrolled ? ' Facteur enrôlé.' : ''}
                      </p>
                    </div>
                    {can && (
                      u.exemption
                        ? <Button size="sm" variant="outline" onClick={() => start({ action: 'revoke', userId: u.id })}>Révoquer</Button>
                        : <Button size="sm" variant="outline" disabled={u.role !== 'USER'} onClick={() => start({ action: 'grant', userId: u.id })}>Autoriser l’exemption</Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pending && (
            <div className="rounded-lg border p-3 space-y-3" data-testid="bo-app-review-confirm">
              <p className="font-medium">{ACTION_LABELS[pending.action]}{pending.kind ? ` (${pending.kind === 'APPLE' ? 'Apple' : 'Google'})` : ''}{pending.userId ? ` — identité #${pending.userId}` : ''}</p>
              <div className="space-y-1">
                <Label htmlFor="app-review-reason">Motif (obligatoire, {data.reasonMinLength} caractères au moins)</Label>
                <Input id="app-review-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="app-review-confirm">Saisissez {data.confirmation} pour confirmer</Label>
                <Input id="app-review-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={submitting || reason.trim().length < data.reasonMinLength || confirm !== data.confirmation} onClick={submit}>
                  {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Confirmer
                </Button>
                <Button size="sm" variant="ghost" disabled={submitting} onClick={() => setPending(null)}>Annuler</Button>
              </div>
            </div>
          )}

          {data.events.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-muted-foreground">Historique</h3>
              <ul className="text-xs space-y-1" data-testid="bo-app-review-events">
                {data.events.map((e) => (
                  <li key={e.id}>
                    {formatDateTime(e.createdAt)} — {EVENT_LABELS[e.event] ?? e.event}{e.kind ? ` (${e.kind})` : ''}{e.userId ? ` · identité #${e.userId}` : ''}
                    {' '}· par {e.actorEmail ?? '—'}{e.reason ? ` · motif : ${e.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
