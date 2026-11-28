"use client";

/**
 * Fiche Compte (BO) — deux blocs DISTINCTS (cartes #876, #879) :
 *
 *   1. « Double authentification » (générique) : par défaut « Appliquer la
 *      politique générale de Verebona » ; action directe « Dispenser de
 *      l'obligation de double authentification » / « Rétablir la politique
 *      générale », PAR IDENTITÉ (accès direct pour un compte à une seule
 *      identité ; choix explicite de chaque identité pour un Duo — aucun
 *      héritage). Aucune qualification, offre, e-mail, rôle ou facturation
 *      n'est nécessaire ni modifié. Affiche la dispense enregistrée, l'état
 *      effectif et la raison de non-effectivité (y compris obligation globale
 *      inactive ou facteur déjà enrôlé).
 *   2. « Compte de revue des stores » (facultatif) : qualification Apple /
 *      Google et droits de démonstration Premium Duo, administrés à part ;
 *      jamais attribués par une dispense.
 *
 * Modification : administrateur (ADMIN) connecté avec la double
 * authentification, réauthentification forte à chaque opération
 * (`ReauthProvider`), motif et phrase de confirmation, compte et identité
 * visés affichés avant confirmation. Toutes ces règles sont VÉRIFIÉES PAR LE
 * SERVEUR (`/api/admin/accounts/[id]/app-review`) : l'interface ne décide de
 * rien. Aucun identifiant ni mot de passe n'est saisi ou affiché ici.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Smartphone, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReauthProvider, useReauth } from '@/components/account/security/ReauthProvider';
import { formatDateTime } from '@/lib/admin/format';

type Kind = 'APPLE' | 'GOOGLE';
type Action = 'qualify' | 'unqualify' | 'grant' | 'revoke' | 'demo_rights';
type UserState = 'POLICY' | 'EFFECTIVE' | 'INACTIVE_POLICY' | 'NOT_EFFECTIVE';

interface AppReviewUser {
  id: number; email: string; firstName: string | null; role: string; status: string; access: string; mfaEnrolled: boolean;
  exemption: { id: number; accountId: number; grantedAt: string; grantedBy: number | null; reason: string } | null;
  state: UserState; effective: boolean; diagnostic: string | null;
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
  EXEMPTION_GRANTED: 'Dispense de l’obligation de double authentification',
  EXEMPTION_REVOKED: 'Politique générale rétablie',
  DEMO_RIGHTS_GRANTED: 'Droits de démonstration Premium Duo',
};

const ACTION_LABELS: Record<Action, string> = {
  qualify: 'Qualifier le compte',
  unqualify: 'Revenir à « Compte client »',
  grant: 'Dispenser de l’obligation de double authentification',
  revoke: 'Rétablir la politique générale',
  demo_rights: 'Attribuer les droits de démonstration Premium Duo',
};

const STATE_LABELS: Record<UserState, string> = {
  POLICY: 'Politique générale de Verebona appliquée.',
  EFFECTIVE: 'Dispensée de l’obligation de double authentification (dispense effective).',
  INACTIVE_POLICY: 'Dispense enregistrée — sans effet actuel.',
  NOT_EFFECTIVE: 'Dispense enregistrée — non effective.',
};

export function AccountAppReview({ accountId }: { accountId: string | number }) {
  return (
    <ReauthProvider>
      <AccountAppReviewInner accountId={accountId} />
    </ReauthProvider>
  );
}

const who = (u: AppReviewUser) => `${u.firstName ? `${u.firstName} — ` : ''}${u.email} (#${u.id})`;

function AccountAppReviewInner({ accountId }: { accountId: string | number }) {
  const { withReauth } = useReauth();
  const [data, setData] = useState<AppReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: Action; user?: AppReviewUser; kind?: Kind } | null>(null);
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

  const start = (p: { action: Action; user?: AppReviewUser; kind?: Kind }) => { setPending(p); setReason(''); setConfirm(''); };

  const submit = async () => {
    if (!pending || !data) return;
    setSubmitting(true);
    try {
      const res = await withReauth(
        () => apiClient.post<{ success: boolean; warning?: string; sessionsRevoked?: number }>(
          `/api/admin/accounts/${accountId}/app-review`,
          { action: pending.action, kind: pending.kind, userId: pending.user?.id, reason, confirm },
        ),
        'Opération d’administration sensible : confirmez votre identité avec une clé d’accès ou l’application d’authentification.',
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
  const readonlyNote = data && !can && (
    <p className="text-xs text-muted-foreground" data-testid="bo-app-review-readonly">
      {data.viewer.strongSession
        ? 'Consultation seule : modifications réservées à un administrateur actif.'
        : 'Consultation seule : reconnectez-vous avec la double authentification (clé d’accès ou application d’authentification) pour modifier.'}
    </p>
  );

  const confirmPanel = pending && data && a && (
    <div className="rounded-lg border p-3 space-y-3" data-testid="bo-app-review-confirm">
      <p className="font-medium">{ACTION_LABELS[pending.action]}{pending.kind ? ` (${pending.kind === 'APPLE' ? 'Apple' : 'Google'})` : ''}</p>
      <dl className="text-xs space-y-0.5" data-testid="bo-app-review-target">
        <div><dt className="inline text-muted-foreground">Compte : </dt><dd className="inline">{a.name} (#{a.id})</dd></div>
        {pending.user && <div><dt className="inline text-muted-foreground">Identité : </dt><dd className="inline">{who(pending.user)}</dd></div>}
      </dl>
      {pending.action === 'grant' && pending.user?.mfaEnrolled && (
        <p className="text-xs text-muted-foreground">Un facteur est déjà enrôlé : la dispense de l’obligation globale ne dispense pas d’un facteur configuré. La double authentification restera exigée et aucun facteur ne sera supprimé.</p>
      )}
      {pending.action === 'revoke' && <p className="text-xs text-muted-foreground">Toutes les sessions de cette identité seront révoquées immédiatement.</p>}
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
  );

  const userAction = (u: AppReviewUser) => !can ? null : u.exemption
    ? <Button size="sm" variant="outline" disabled={u.exemption.accountId !== a?.id} onClick={() => start({ action: 'revoke', user: u })}>Rétablir la politique générale</Button>
    : <Button size="sm" variant="outline" disabled={u.role !== 'USER'} onClick={() => start({ action: 'grant', user: u })}>Dispenser de l’obligation de double authentification</Button>;

  const history = (events: AppReviewPayload['events'], title: string) => events.length === 0 ? null : (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul className="text-xs space-y-1" data-testid="bo-app-review-events">
        {events.map((e) => (
          <li key={e.id}>
            {formatDateTime(e.createdAt)} — {EVENT_LABELS[e.event] ?? e.event}{e.kind ? ` (${e.kind})` : ''}{e.userId ? ` · identité #${e.userId}` : ''}
            {' '}· par {e.actorEmail ?? '—'}{e.reason ? ` · motif : ${e.reason}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );

  const isMfaPending = pending && (pending.action === 'grant' || pending.action === 'revoke');

  return (
    <>
      <section className="rounded-xl border bg-card overflow-hidden" data-testid="bo-account-mfa-exemption">
        <div className="px-5 py-4 border-b">
          <h2 className="vb-app-section flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Double authentification
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
          <div className="px-5 py-4 space-y-3 text-sm">
            <p className="text-xs text-muted-foreground" data-testid="bo-mfa-enforcement">
              Obligation globale de double authentification : {data.mfaEnforcement.users ? 'en vigueur' : 'non activée (la double authentification est facultative pour tous)'}.
              Une dispense ne neutralise que cette obligation : un facteur déjà enrôlé reste exigé, la session reste de niveau 1, les autres contrôles sont inchangés.
              Un administrateur ne peut jamais être dispensé.
            </p>
            {readonlyNote}
            {data.users.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucune identité active sur ce compte.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {data.users.map((u) => (
                  <li key={u.id} className="px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" data-testid={`bo-mfa-user-${u.id}`}>
                    <div className="text-xs space-y-0.5">
                      <p className="text-sm">{who(u)} <span className="text-muted-foreground">· {u.access} · {u.role} · {u.status}{u.mfaEnrolled ? ' · facteur enrôlé' : ''}</span></p>
                      <p data-testid={`bo-mfa-state-${u.id}`} data-state={u.state}>
                        {u.state === 'POLICY' ? 'Appliquer la politique générale de Verebona (par défaut).' : STATE_LABELS[u.state]}
                      </p>
                      {u.exemption && (
                        <p className="text-muted-foreground">Dispense enregistrée le {formatDateTime(u.exemption.grantedAt)} · motif : {u.exemption.reason}</p>
                      )}
                      {u.diagnostic && <p className="text-muted-foreground">{u.diagnostic}</p>}
                    </div>
                    {userAction(u)}
                  </li>
                ))}
              </ul>
            )}
            {data.users.length > 1 && (
              <p className="text-xs text-muted-foreground">Compte à plusieurs identités : chaque identité se dispense explicitement ; un invité actuel ou futur n’hérite d’aucune dispense.</p>
            )}
            {isMfaPending && confirmPanel}
            {history(data.events.filter((e) => e.event.startsWith('EXEMPTION_')), 'Historique des dispenses')}
          </div>
        )}
      </section>

      {data && a && (
        <section className="rounded-xl border bg-card overflow-hidden" data-testid="bo-account-app-review">
          <div className="px-5 py-4 border-b">
            <h2 className="vb-app-section flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-muted-foreground" />
              Compte de revue des stores (facultatif)
            </h2>
          </div>
          <div className="px-5 py-4 space-y-3 text-sm">
            <p>Qualification : <strong data-testid="bo-app-review-kind">{a.kindLabel}</strong> <span className="text-xs text-muted-foreground">(libellé facultatif, indépendant de l’offre et de la double authentification)</span></p>
            {a.kind && (
              <p className="text-xs text-muted-foreground">Droits effectifs : offre {a.planType}, abonnement {a.rights.planCode ?? '—'} / {a.rights.status ?? '—'}.</p>
            )}
            {readonlyNote}
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
            {pending && !isMfaPending && confirmPanel}

            {history(data.events.filter((e) => !e.event.startsWith('EXEMPTION_')), 'Historique du compte de revue')}
          </div>
        </section>
      )}
    </>
  );
}
