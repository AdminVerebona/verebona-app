'use client';

/**
 * « Compte en cours de suppression » — seul écran d'un compte clôturé
 * (suppression volontaire différée de 30 jours, `lib/auth/account-closure`).
 *
 * Deux actions, et rien d'autre :
 *   - ANNULER la suppression : l'accès normal est rétabli immédiatement ;
 *     l'abonnement résilié n'est pas réactivé d'office et le partage Duo
 *     n'est pas rétabli (à refaire depuis Mon compte) ;
 *   - EXPORTER ses données (export RGPD « Mes données », même composant que
 *     Mon compte).
 *
 * Le middleware y renvoie toute page protégée tant que le compte est
 * clôturé ; un compte qui ne l'est pas (ou plus) est renvoyé à l'accueil.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Loader2, LogOut, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MyDataCard } from '@/app/(dashboard)/mon-compte/mes-donnees/MyDataCard';

interface DeletionState {
  /** `closed` : compte clôturé sans suppression programmée active (exécution en échec ou en cours). */
  status: 'none' | 'scheduled' | 'closed';
  confirmedAt: string | null;
  scheduledAt: string | null;
  daysLeft: number | null;
}

function longDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(new Date(iso));
}

/** Appel authentifié : un jeton d'accès expiré (15 min) est renouvelé une fois. */
async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', cache: 'no-store', ...init });
  if (res.status !== 401) return res;
  const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!refreshed.ok) return res;
  return fetch(input, { credentials: 'include', cache: 'no-store', ...init });
}

export default function AccountPendingDeletionPage() {
  const router = useRouter();
  const [state, setState] = useState<DeletionState | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await authFetch('/api/users/me/deletion');
      if (res.status === 401) {
        router.replace('/login?returnUrl=/compte-en-suppression');
        return;
      }
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { deletion: DeletionState };
      if (data.deletion.status === 'none') {
        // Compte actif en base : la session est renouvelée d'abord, pour qu'un
        // jeton encore marqué « clôturé » ne ramène pas ici (boucle).
        await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).catch(() => undefined);
        window.location.assign('/accueil');
        return;
      }
      setState(data.deletion);
      const me = await authFetch('/api/users/me');
      if (me.ok) setEmail(((await me.json()) as { email?: string }).email ?? null);
    } catch {
      setLoadError('Impossible de charger l’état de votre compte. Réessayez dans quelques instants.');
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  const cancelDeletion = async () => {
    setCancelling(true);
    try {
      const res = await authFetch('/api/users/me/deletion', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.message || 'L’annulation n’a pas pu être enregistrée. Réessayez.');
        setCancelling(false);
        return;
      }
      toast.success('La suppression de votre compte est annulée.');
      // Rechargement complet : la session vient d'être rouverte au statut actif.
      window.location.assign(data.redirectTo || '/accueil');
    } catch {
      toast.error('Erreur réseau : l’annulation n’a pas pu être envoyée.');
      setCancelling(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
    try { localStorage.removeItem('user'); } catch { /* stockage indisponible */ }
    window.location.assign('/login');
  };

  return (
    <main className="min-h-screen bg-[color:var(--bg-page)] px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <Card className="border-red-500/30">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <CardTitle className="text-red-500">Votre compte est en cours de suppression</CardTitle>
            </div>
            <CardDescription>
              {email ? <>Connecté en tant que <strong>{email}</strong>. </> : null}
              Vous avez demandé la suppression de votre compte : il est clôturé et vous ne pouvez plus utiliser Verebona normalement.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            {loadError ? (
              <div>
                <p className="text-destructive">{loadError}</p>
                <button type="button" className="mt-1 underline text-xs" onClick={() => void load()}>Réessayer</button>
              </div>
            ) : !state ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
              </div>
            ) : (
              <>
                <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-950/10 px-4 py-3">
                  <CalendarClock className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
                  <div>
                    <p className="font-semibold">
                      {state.status === 'closed' || state.daysLeft === 0
                        ? 'Suppression définitive en cours de traitement'
                        : <>Suppression définitive le {state.scheduledAt ? longDate(state.scheduledAt) : '—'}
                          {state.daysLeft != null && ` (dans ${state.daysLeft} jour${state.daysLeft > 1 ? 's' : ''})`}</>}
                    </p>
                    <p className="text-[color:var(--text-secondary)]">
                      À cette date, vos biens, documents, fichiers, échéances, l’historique de l’assistant et votre profil
                      seront définitivement supprimés. Restent conservés, détachés de votre compte : les factures, les
                      preuves d’acceptation des conditions générales, vos éventuelles demandes de rétractation, ainsi que
                      la trace de votre demande de suppression et son inscription au registre des demandes RGPD (sans
                      votre adresse e-mail).
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="font-semibold">Vous avez changé d’avis ?</p>
                  <p className="text-[color:var(--text-secondary)]">
                    Annulez la suppression pour retrouver immédiatement votre compte et vos données. Votre abonnement
                    n’est pas réactivé automatiquement : il s’arrête à la fin de la période déjà payée, sauf si vous
                    relancez son renouvellement depuis Mon compte &gt; Offres. Un partage Premium Duo interrompu doit
                    faire l’objet d’une nouvelle invitation.
                  </p>
                  <Button onClick={cancelDeletion} disabled={cancelling} className="gap-2">
                    {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Annuler la suppression de mon compte
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {state && (
          <div className="space-y-2">
            <p className="text-sm text-[color:var(--text-secondary)]">
              Avant la suppression, vous pouvez télécharger une copie de toutes vos données :
            </p>
            <MyDataCard />
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={logout} className="gap-2 text-muted-foreground">
            <LogOut className="h-4 w-4" /> Se déconnecter
          </Button>
        </div>
      </div>
    </main>
  );
}
