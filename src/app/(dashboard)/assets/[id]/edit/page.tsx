"use client"

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';

// Phase 14: This page is deprecated. Redirect to the new detail page with details tab.
export default function AssetEditRedirect() {
  const router = useRouter();
  const params = useParams();

  useEffect(() => {
    const id = params.id as string;
    router.replace(`/assets/${id}?tab=details`);
  }, [params.id, router]);

  return null;
}
