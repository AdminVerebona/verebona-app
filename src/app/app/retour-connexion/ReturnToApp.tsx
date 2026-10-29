'use client';

import { Button } from '@/components/ui/button';

/**
 * Sur Android, un lien d'application vérifié ouvert par un geste de
 * l'utilisateur rouvre l'application : le bouton renvoie vers la même adresse.
 */
export function ReturnToApp() {
  return (
    <Button className="w-full" onClick={() => { window.location.href = window.location.href; }}>
      Ouvrir l’application Verebona
    </Button>
  );
}
