'use client';

/**
 * Lot 97B — vrai dans l'application iOS / Android, où les actions
 * commerciales sont masquées (`lib/native/commerce`). Décidé APRÈS
 * l'hydratation (premier rendu identique serveur / navigateur) ; toujours faux
 * dans un navigateur : le Web est inchangé.
 */
import { useEffect, useState } from 'react';
import { nativeCommerceHidden } from '@/lib/native/commerce';

export function useNativeCommerceHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { setHidden(nativeCommerceHidden()); }, []);
  return hidden;
}
