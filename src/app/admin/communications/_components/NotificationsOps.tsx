'use client';

/**
 * Notifications — santé, recherche, réémission (CDC 3 §20.1 à §20.3 ;
 * décision PO D-L, lot 21).
 *
 * Branche dans l'écran Communications les routes du BO jusqu'ici sans
 * écran : santé (`/health`), indicateurs 30 j (`/metrics`), recherche
 * (`/search`, journalisée), aperçu et réémission confirmée (`/reemit`, et
 * `/[outboxId]/resend` pour une livraison en échec). Composants existants de
 * la page ; chaque action est journalisée côté serveur.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';

interface Health {
  fenetreHeures: number;
  livraisonsParCanal: Array<{ canal: string; total: number; envoyees: number; echouees: number; tauxSucces: number | null }>;
  outbox: { enAttente: number; enErreur: number; bloquesDepuisSeuil: number; plusAncienEnAttenteMinutes: number | null };
  sain: boolean;
  alertes: string[];
}
interface Metrics { windowDays: number; successRate: number | null; failedEmails: number; activeSubscriptions: number }
interface Event {
  id: string; eventType: string; recipientUserId: number | null; status: string; createdAt: string;
  lastError: string | null; deliveries: Array<{ channel: string; status: string; count: number }>;
}
interface Preview { eventType: string; destinataire: number | null; statutOrigine: string; soumisAConsentement: boolean }

export function NotificationsOps() {
  const [health, setHealth] = useState<Health | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [userId, setUserId] = useState('');
  const [type, setType] = useState('');
  const [events, setEvents] = useState<Event[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [cible, setCible] = useState<{ event: Event; preview: Preview | null } | null>(null);
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [h, m] = await Promise.allSettled([
      apiClient.get<Health>('/api/admin/notifications/health?heures=24'),
      apiClient.get<Metrics>('/api/admin/notifications/metrics?days=30'),
    ]);
    setHealth(h.status === 'fulfilled' ? h.value : null);
    setMetrics(m.status === 'fulfilled' ? m.value : null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rechercher = async () => {
    setSearching(true);
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (/^\d+$/.test(userId.trim())) q.set('userId', userId.trim());
      if (type.trim()) q.set('type', type.trim());
      setEvents((await apiClient.get<{ events: Event[] }>(`/api/admin/notifications/search?${q}`)).events);
    } catch {
      toast.error('Recherche impossible.');
    } finally {
      setSearching(false);
    }
  };

  const ouvrir = async (event: Event) => {
    setMotif('');
    setCible({ event, preview: null });
    try {
      const preview = await apiClient.get<Preview>(`/api/admin/notifications/reemit?id=${encodeURIComponent(event.id)}`);
      setCible({ event, preview });
    } catch {
      toast.error('Aperçu indisponible.');
      setCible(null);
    }
  };

  const reemettre = async () => {
    if (!cible) return;
    setBusy(true);
    try {
      // Livraison en échec : renvoi (`/resend`) ; sinon réémission. Même
      // contrôle §20.3 côté serveur, confirmation explicite.
      const url = cible.event.status === 'failed'
        ? `/api/admin/notifications/${encodeURIComponent(cible.event.id)}/resend`
        : '/api/admin/notifications/reemit';
      await apiClient.post(url, { outboxId: cible.event.id, confirme: true, motif: motif.trim() || undefined });
      toast.success('Notification réémise.');
      setCible(null);
      await Promise.all([load(), events ? rechercher() : Promise.resolve()]);
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Réémission refusée.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" data-testid="notifications-ops">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Notifications — santé et réémission</h2>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Actualiser la santé des notifications">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-3">
        {!health ? (
          <p className="text-sm text-muted-foreground">Santé indisponible.</p>
        ) : (
          <>
            <p className={`text-sm ${health.sain ? 'text-emerald-500' : 'text-amber-500'}`}>
              {health.sain ? 'File saine sur 24 h.' : 'À surveiller sur 24 h.'}
              <span className="text-muted-foreground">
                {' '}· {health.outbox.enAttente} en attente · {health.outbox.enErreur} en erreur · {health.outbox.bloquesDepuisSeuil} bloquée(s) depuis plus d’une heure
              </span>
            </p>
            {health.alertes.map((a, i) => <p key={i} className="text-xs text-amber-500">{a}</p>)}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-2 py-1 font-medium">Canal</th><th className="px-2 py-1 font-medium text-right">Livraisons</th>
                    <th className="px-2 py-1 font-medium text-right">Envoyées</th><th className="px-2 py-1 font-medium text-right">Échecs</th>
                    <th className="px-2 py-1 font-medium text-right">Succès</th>
                  </tr>
                </thead>
                <tbody>
                  {health.livraisonsParCanal.map((c) => (
                    <tr key={c.canal} className="border-t">
                      <td className="px-2 py-1">{c.canal}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{c.total}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{c.envoyees}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{c.echouees}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{c.tauxSucces == null ? '—' : `${c.tauxSucces} %`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {metrics && (
          <p className="text-xs text-muted-foreground">
            30 jours : succès {metrics.successRate == null ? '—' : `${metrics.successRate} %`} · {metrics.failedEmails} e-mail(s) en échec · {metrics.activeSubscriptions} abonnement(s) push actif(s)
          </p>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-40" placeholder="Utilisateur (n°)" aria-label="Identifiant utilisateur" value={userId} onChange={(e) => setUserId(e.target.value)} />
          <Input className="w-56" placeholder="Type d’événement" aria-label="Type d’événement" value={type} onChange={(e) => setType(e.target.value)} />
          <Button size="sm" variant="outline" onClick={() => void rechercher()} disabled={searching}>
            {searching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1.5" />} Rechercher
          </Button>
          <span className="text-xs text-muted-foreground">Recherche journalisée.</span>
        </div>
        {events && (events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun événement.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">Date</th><th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium">Destinataire</th><th className="px-2 py-1 font-medium">Statut</th>
                  <th className="px-2 py-1 font-medium">Livraisons</th><th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="px-2 py-1 text-xs">{formatDateTime(e.createdAt)}</td>
                    <td className="px-2 py-1">{e.eventType}</td>
                    <td className="px-2 py-1 tabular-nums">{e.recipientUserId ?? '—'}</td>
                    <td className="px-2 py-1">{e.status}{e.lastError ? <span className="block text-xs text-red-500">{e.lastError}</span> : null}</td>
                    <td className="px-2 py-1 text-xs">{e.deliveries.map((d) => `${d.channel} ${d.status} (${d.count})`).join(' · ') || '—'}</td>
                    <td className="px-2 py-1 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void ouvrir(e)}>Réémettre…</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* §20.3 condition 4 : confirmation explicite, aperçu préalable. */}
      <AlertDialog open={!!cible} onOpenChange={(o) => { if (!o && !busy) setCible(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Réémettre cette notification ?</AlertDialogTitle>
            <AlertDialogDescription>
              {cible?.preview
                ? `${cible.preview.eventType} → utilisateur ${cible.preview.destinataire ?? 'inconnu'} (statut d’origine : ${cible.preview.statutOrigine}).`
                  + (cible.preview.soumisAConsentement ? ' Actualité : le consentement du destinataire est vérifié.' : '')
                  + ' Une nouvelle notification est créée et l’opération est journalisée.'
                : 'Chargement de l’aperçu…'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input placeholder="Motif (facultatif)" aria-label="Motif de la réémission" value={motif} onChange={(e) => setMotif(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={busy || !cible?.preview} onClick={(ev) => { ev.preventDefault(); void reemettre(); }}>
              Réémettre
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
