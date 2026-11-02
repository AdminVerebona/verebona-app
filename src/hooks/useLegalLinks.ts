'use client';

/**
 * Liens légaux publics à jour (lot 102B) : valeurs de départ figées au build
 * (repli sur les adresses ACTUELLES du site public), puis liens résolus par le
 * serveur (`GET /api/legal/links`) — qui bascule automatiquement sur les
 * nouvelles adresses /legal/… dès que le manifeste du site a été lu. Une seule
 * lecture par chargement de page (promesse partagée). Jamais de lien mort : en
 * cas d'échec, les valeurs de départ restent.
 */
import { useEffect, useState } from 'react';
import { LEGAL_DOCUMENT_KEYS, clientLegalLinks, type LegalLinks } from '@/lib/legal/public-legal';
import { registerServerLegalOrigins } from '@/lib/legal/open-legal-link';

let shared: Promise<LegalLinks | null> | null = null;

function isLinks(v: unknown): v is LegalLinks {
  return !!v && typeof v === 'object' && LEGAL_DOCUMENT_KEYS.every((k) => typeof (v as Record<string, unknown>)[k] === 'string' && /^https?:\/\//.test((v as Record<string, string>)[k]));
}

function loadServerLinks(): Promise<LegalLinks | null> {
  shared ??= fetch('/api/legal/links', { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { links?: unknown; allowedOrigins?: unknown } | null) => {
      // Lot 103A : origines juridiques admises par le serveur (liste blanche de `LegalLink`).
      registerServerLegalOrigins(d?.allowedOrigins);
      return isLinks(d?.links) ? d!.links as LegalLinks : null;
    })
    .catch(() => null);
  return shared;
}

/** Lance (une fois) la lecture des liens et origines juridiques du serveur. */
export function preloadLegalLinks(): void {
  if (typeof window !== 'undefined') void loadServerLinks();
}

export function useLegalLinks(): LegalLinks {
  const [links, setLinks] = useState<LegalLinks>(() => clientLegalLinks());
  useEffect(() => {
    let alive = true;
    void loadServerLinks().then((l) => { if (alive && l) setLinks(l); });
    return () => { alive = false; };
  }, []);
  return links;
}
