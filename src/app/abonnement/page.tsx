"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Redirection vers l'offre ou vers la page publique.
 *
 * Cette page orientait l'utilisateur selon la présence d'un jeton dans le
 * `localStorage`. Cette information n'est plus lisible en JavaScript : la
 * session vit dans un cookie HttpOnly (CDC cookies §5.6). On interroge donc le
 * serveur, comme le fait déjà la page de connexion.
 */
export default function AbonnementRedirect() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (cancelled) return;
        // Une session valide mène à la gestion de l'offre ; sinon, à la
        // présentation publique des tarifs.
        router.replace(res.ok ? '/mon-compte/offres' : '/#pricing');
      } catch {
        if (!cancelled) router.replace('/#pricing');
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  return null;
}
