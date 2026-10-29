'use client';

/**
 * Fiche utilisateur BO — sessions actives (lot 92, CDC 18 §20, §26).
 * Affichée seulement si le réglage `AUTH_BO_SESSION_LIST` est activé (USR-D03
 * par défaut : aucune liste). Appareil, navigateur ou application, dernière
 * activité ; jamais d'IP. « Déconnecter » une session : journalisé.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/admin/format';

interface BoSession {
  id: string;
  clientType: string;
  deviceLabel: string;
  browserLabel: string;
  createdAt: string;
  lastSeenAt: string;
}

const CLIENT_LABEL: Record<string, string> = { WEB: 'Web', PWA: 'Application web installée', IOS: 'iOS', ANDROID: 'Android' };

export function UserSessionsCard({ userId }: { userId: string }) {
  const [state, setState] = useState<{ enabled: boolean; sessions: BoSession[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/users/${userId}/sessions`, { credentials: 'include', cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) setState({ enabled: !!body.enabled, sessions: Array.isArray(body.sessions) ? body.sessions : [] });
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  if (!state?.enabled) return null;

  const revoke = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/admin/users/${userId}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || `Erreur ${res.status}`);
      toast.success('Session déconnectée');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions actives</CardTitle>
      </CardHeader>
      <CardContent>
        {state.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune session inscrite au registre.</p>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {state.sessions.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{s.deviceLabel} · {s.browserLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {CLIENT_LABEL[s.clientType] ?? s.clientType} · dernière activité {formatDateTime(s.lastSeenAt)} · ouverte {formatDateTime(s.createdAt)}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => revoke(s.id)} className="w-full sm:w-auto">
                  Déconnecter
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Les sessions ouvertes avant le registre apparaissent à leur prochain renouvellement. « Déconnecter toutes les sessions » (Actions) les coupe toutes.
        </p>
      </CardContent>
    </Card>
  );
}
