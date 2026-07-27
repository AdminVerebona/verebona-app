"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { getPermissionState, isPushSupported, type PushPermission } from '@/lib/push/push-client';

/**
 * Carte d'accès aux réglages de notification, affichée sur la page Mon compte
 * (CDC §8.1). Résume l'état du push sur cet appareil et le nombre d'appareils
 * autorisés, puis renvoie vers la page dédiée.
 */
export function NotificationsCard() {
  const router = useRouter();
  const [permission, setPermission] = useState<PushPermission>('unsupported');
  const [deviceCount, setDeviceCount] = useState<number | null>(null);

  useEffect(() => {
    setPermission(isPushSupported() ? getPermissionState() : 'unsupported');
    apiClient
      .get<{ push?: { activeDeviceCount: number } }>('/api/notification-preferences')
      .then((r) => setDeviceCount(r.push?.activeDeviceCount ?? 0))
      .catch(() => setDeviceCount(null));
  }, []);

  const status = (() => {
    if (permission === 'unsupported') return { label: 'Non pris en charge sur cet appareil', tone: 'muted' as const };
    if (permission === 'denied') return { label: 'Bloqué dans le navigateur', tone: 'warn' as const };
    if (permission === 'granted' && (deviceCount ?? 0) > 0) {
      return { label: `Activé · ${deviceCount} appareil${(deviceCount ?? 0) > 1 ? 's' : ''}`, tone: 'ok' as const };
    }
    return { label: 'Non activé sur cet appareil', tone: 'muted' as const };
  })();

  const dot = status.tone === 'ok' ? 'bg-emerald-500' : status.tone === 'warn' ? 'bg-amber-500' : 'bg-muted-foreground/40';

  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <Bell className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">Notifications</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
            {status.label}
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push('/mon-compte/notifications')} className="shrink-0">
          Gérer mes notifications
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
