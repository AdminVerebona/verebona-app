"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ChevronRight } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

/**
 * Carte d'accès aux réglages de notification, affichée sur la page Mon compte
 * (CDC §8.1). Résume le nombre d'appareils qui reçoivent le push, puis
 * renvoie vers la page dédiée. Lot 97 (CDC 12 §18) : plus d'état de
 * permission du navigateur — le Web ne demande plus l'autorisation, les push
 * arrivent sur les téléphones (application mobile).
 */
export function NotificationsCard() {
  const router = useRouter();
  const [deviceCount, setDeviceCount] = useState<number | null>(null);

  useEffect(() => {
    apiClient
      .get<{ push?: { activeDeviceCount: number } }>('/api/notification-preferences')
      .then((r) => setDeviceCount(r.push?.activeDeviceCount ?? 0))
      .catch(() => setDeviceCount(null));
  }, []);

  const status = (deviceCount ?? 0) > 0
    ? { label: `Push activé · ${deviceCount} appareil${(deviceCount ?? 0) > 1 ? 's' : ''}`, tone: 'ok' as const }
    : { label: 'Push : aucun appareil pour le moment', tone: 'muted' as const };

  const dot = status.tone === 'ok' ? 'bg-[color:var(--accent)]' : 'bg-muted-foreground/40';

  return (
    // Tiroir fermé par défaut : titre, une ligne, chevron (modèle « Informations légales »).
    <CollapsibleCard
      icon={<Bell className="w-5 h-5" />}
      title="Gestion des notifications"
      description="Notifications de vos échéances et de vos documents sur vos téléphones et par e-mail."
      contentClassName="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
        {status.label}
      </p>
      <Button variant="outline" onClick={() => router.push('/mon-compte/notifications')} className="shrink-0">
        Gérer mes notifications
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </CollapsibleCard>
  );
}
