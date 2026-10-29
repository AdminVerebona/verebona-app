"use client";

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  APP_UPDATE_REQUIRED_EVENT, mobileClientHeaders, nativeShellInfo, type AppUpdateRequiredDetail,
} from '@/lib/mobile/native-shell';

/**
 * Écran bloquant « Mise à jour requise » — lot 97 (CDC 12 §4.3 « Version
 * obsolète », VER-03, REC-061).
 *
 * Monté à la racine ; n'apparaît QUE dans l'application mobile native
 * (`window.VerebonaNative`) : jamais dans un navigateur. Deux déclencheurs :
 *   · au démarrage et au retour au premier plan, lecture de
 *     `GET /api/mobile/config` (bloc `client.updateRequired`) ;
 *   · tout refus `APP_UPDATE_REQUIRED` d'un appel d'API (api-client).
 * Le bouton ouvre la fiche de l'application dans le store.
 */
export function AppUpdateRequiredGate() {
  const [detail, setDetail] = useState<AppUpdateRequiredDetail | null>(null);

  useEffect(() => {
    const native = nativeShellInfo();
    if (!native) return;
    const onRefus = (e: Event) => setDetail((e as CustomEvent<AppUpdateRequiredDetail>).detail ?? {});
    window.addEventListener(APP_UPDATE_REQUIRED_EVENT, onRefus);

    const verifier = async () => {
      try {
        const res = await fetch('/api/mobile/config', { headers: mobileClientHeaders(), cache: 'no-store' });
        if (!res.ok) return;
        const cfg = await res.json() as {
          client?: { updateRequired?: boolean };
          platforms?: Record<string, { minVersion?: string | null; storeUrl?: string | null }>;
        };
        if (cfg.client?.updateRequired) {
          const p = cfg.platforms?.[native.platform];
          setDetail({ minVersion: p?.minVersion ?? null, storeUrl: p?.storeUrl ?? null });
        }
      } catch {
        /* hors réseau : l'écran « Connexion Internet requise » de l'app s'en charge */
      }
    };
    void verifier();
    const onVisible = () => { if (document.visibilityState === 'visible') void verifier(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(APP_UPDATE_REQUIRED_EVENT, onRefus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!detail) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="vb-update-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6"
      style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="w-full max-w-sm space-y-4 text-center">
        <Download className="mx-auto h-10 w-10 text-[color:var(--accent)]" aria-hidden />
        <h1 id="vb-update-title" className="vb-app-title">Mise à jour requise</h1>
        <p className="text-sm text-muted-foreground">
          Cette version de Verebona n&apos;est plus prise en charge. Installez la dernière version pour continuer :
          vos données et votre session sont conservées.
        </p>
        {detail.storeUrl ? (
          <Button className="w-full" onClick={() => window.open(detail.storeUrl as string, '_blank', 'noopener')}>
            Mettre à jour l&apos;application
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Ouvrez la boutique d&apos;applications de votre téléphone pour mettre à jour Verebona.</p>
        )}
      </div>
    </div>
  );
}
