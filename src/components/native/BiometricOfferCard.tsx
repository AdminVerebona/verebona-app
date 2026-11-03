'use client';

/**
 * Proposition d'activation du déverrouillage biométrique — lot 107A (#640).
 *
 * Non bloquante (carte en bas d'écran, l'app reste utilisable), affichée UNE
 * fois par appareil et par compte après une connexion réussie (voir
 * `shouldOfferBiometrics`). « Activer » lance la vérification native ; le
 * choix n'est enregistré qu'après un succès complet. « Plus tard » : rien
 * n'est activé, aucune nouvelle proposition (réglage dans Mon compte ›
 * Sécurité). Accessibilité : `dialog` titré et décrit, focus sur « Activer ».
 */
import { useEffect, useRef } from 'react';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BIOMETRIC_OFFER_DESCRIPTION, BIOMETRIC_SHARED_DEVICE_NOTE, biometricOfferTitle } from '@/lib/native/biometric-consent';

interface Props {
  type: number | null;
  busy: boolean;
  onActivate: () => void;
  onLater: () => void;
}

export function BiometricOfferCard({ type, busy, onActivate, onLater }: Props) {
  const activate = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { activate.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="vb-bio-offer-title"
      aria-describedby="vb-bio-offer-desc"
      data-testid="biometric-offer"
      className="fixed inset-x-3 z-[998] rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 shadow-lg"
      style={{ bottom: 'max(1rem, calc(var(--vb-safe-bottom) + 4.5rem))' }}
    >
      <div className="flex items-start gap-3">
        <Fingerprint className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
        <div className="space-y-3">
          <p id="vb-bio-offer-title" className="text-sm font-medium">{biometricOfferTitle(type)}</p>
          <div id="vb-bio-offer-desc" className="space-y-1">
            <p className="text-xs text-[color:var(--text-muted)]">{BIOMETRIC_OFFER_DESCRIPTION}</p>
            <p className="text-xs text-[color:var(--text-muted)]">{BIOMETRIC_SHARED_DEVICE_NOTE}</p>
          </div>
          <div className="flex gap-2">
            <Button ref={activate} size="sm" onClick={onActivate} disabled={busy}>Activer</Button>
            <Button size="sm" variant="outline" onClick={onLater} disabled={busy}>Plus tard</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
