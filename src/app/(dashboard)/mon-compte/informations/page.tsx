'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function InformationsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/mon-compte?tab=informations');
  }, [router]);

  return null;
}
