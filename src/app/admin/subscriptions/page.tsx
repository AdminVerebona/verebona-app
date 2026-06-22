"use client";
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function SubscriptionsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/accounts'); }, [router]);
  return null;
}
