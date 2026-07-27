"use client";

import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  isPushSupported, getPermissionState, subscribeCurrentDevice,
} from '@/lib/push/push-client';

/**
 * Encart in-app de demande d'autorisation push (CDC §9.2, contextes 2 et 3).
 *
 * Affiche d'abord une explication Verebona avec « Activer » et « Plus tard ».
 * Le prompt système du navigateur n'est appelé qu'après « Activer » (§9.1).
 * Ne s'affiche jamais si le push n'est pas pris en charge, si la permission
 * n'est pas à l'état `default`, ou si l'utilisateur a déjà refusé cet encart.
 *
 * À monter aux endroits prévus par le CDC :
 *  - après la création de la première échéance (context="deadline") ;
 *  - après un premier import documentaire (context="document").
 */
export function PushPermissionInlinePrompt({
  context,
  storageKey,
}: {
  context: 'deadline' | 'document';
  storageKey: string;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) return;
    if (getPermissionState() !== 'default') return;
    try {
      if (localStorage.getItem(storageKey) === 'dismissed') return;
    } catch { /* localStorage indisponible : on affiche quand même */ }
    setVisible(true);
  }, [storageKey]);

  if (!visible) return null;

  const message = context === 'deadline'
    ? 'Souhaitez-vous être prévenu 7 jours avant vos échéances, même lorsque Verebona est fermé ?'
    : 'Souhaitez-vous être prévenu dès que l’analyse de vos documents est terminée, même lorsque Verebona est fermé ?';

  const dismiss = () => {
    try { localStorage.setItem(storageKey, 'dismissed'); } catch { /* ignore */ }
    setVisible(false);
  };

  const activate = async () => {
    setBusy(true);
    try {
      const res = await subscribeCurrentDevice('Cet appareil');
      if (res.ok) {
        toast.success('Notifications activées sur cet appareil');
        try { localStorage.setItem(storageKey, 'activated'); } catch { /* ignore */ }
        setVisible(false);
      } else if (res.reason === 'denied') {
        toast.error('Autorisation refusée. Vous pouvez la réactiver dans les réglages du navigateur.');
        setVisible(false);
      } else {
        toast.error('Impossible d’activer les notifications pour le moment.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background">
        <Bell className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Activer les notifications ?</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{message}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={activate} disabled={busy}>Activer</Button>
          <Button size="sm" variant="ghost" onClick={dismiss} disabled={busy}>Plus tard</Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Fermer"
        className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
