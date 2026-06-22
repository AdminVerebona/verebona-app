"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AbonnementRedirect() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
    if (token) {
      router.replace('/mon-compte/offres');
    } else {
      router.replace('/#pricing');
    }
  }, [router]);

  return null;
}
