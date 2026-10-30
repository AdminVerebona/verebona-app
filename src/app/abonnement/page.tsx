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
const OFFERS_LOGIN_PATH = `/login?returnUrl=${encodeURIComponent('/mon-compte/offres')}`;

export default function AbonnementRedirect() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (cancelled) return;
        // Une session valide mène à la gestion de l'offre. Lot 100G (E2, F) :
        // sans session, connexion PUIS retour aux offres (utilisateur déjà
        // inscrit reconnu, aucun jeton dans l'URL) — l'ancien repli `/#pricing`
        // visait l'application, dont la racine renvoie à la connexion en
        // perdant l'ancre (la section Tarifs `#pricing` est sur le site public).
        router.replace(res.ok ? '/mon-compte/offres' : OFFERS_LOGIN_PATH);
      } catch {
        if (!cancelled) router.replace(OFFERS_LOGIN_PATH);
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  return null;
}
