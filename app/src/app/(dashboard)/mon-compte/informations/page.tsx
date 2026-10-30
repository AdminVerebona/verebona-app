'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { informationsRedirectTarget } from './redirect-target';

/** Ancienne adresse de Mon compte › Informations (paramètres et ancre conservés, lot 101C). */
export default function InformationsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(informationsRedirectTarget(window.location.search, window.location.hash));
  }, [router]);

  return null;
}
