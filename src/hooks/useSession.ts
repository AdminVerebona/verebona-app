'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import type { UserRole, PlanType, SubscriptionStatus } from '@/types/domain';

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  username?: string | null;
  accountName?: string;
  role: UserRole;
  subscription: {
    plan: PlanType;
    status: SubscriptionStatus;
  };
  duoId?: number;
  duoStatus?: 'ACTIVE' | 'PAST_DUE_GRACE' | 'UNPAID_RECOVERY' | 'CANCELED';
  duoRole?: 'BILLING_OWNER' | 'MEMBER';
  duoActivatedAt?: string;
  graceDeadlineAt?: string;
  duoEntitlement?: boolean;
  isInRecovery?: boolean;
}

interface UseSessionOptions {
  required?: boolean;
  redirectTo?: string;
}

interface UseSessionReturn {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function getCachedUser(): User | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Reject cache if it doesn't have the expected nested shape from /api/users/me
    if (!parsed?.subscription?.plan) return null;
    return parsed as User;
  } catch {
    return null;
  }
}

export function useSession(
  options: UseSessionOptions = {}
): UseSessionReturn {
  const { required = false, redirectTo = '/login' } = options;
  const router = useRouter();

  // Initialise synchronously from localStorage so the first render is instant
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const hasToken = true;
    // Only skip loading if we have a valid cached user (correct shape)
    return !(hasToken && getCachedUser() !== null);
  });
  const [error, setError] = useState<string | null>(null);

  const fetchUser = async () => {
    const hasToken = typeof window !== 'undefined' && true;

    if (!hasToken) {
      setUser(null);
      localStorage.removeItem('user');
      setIsLoading(false);
      setError('No token found');

      if (required) {
        const currentPath = window.location.pathname;
        if (
          currentPath === redirectTo ||
          currentPath.startsWith('/login') ||
          currentPath.startsWith('/signup') ||
          currentPath.startsWith('/forgot-password')
        ) {
          return;
        }
        const returnUrl = encodeURIComponent(currentPath);
        router.push(`${redirectTo}?returnUrl=${returnUrl}`);
      }
      return;
    }

    try {
      setError(null);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Session timeout')), 4000)
      );
      const userData = await Promise.race([
        apiClient.get<User>('/api/users/me', { useCache: true }),
        timeoutPromise,
      ]);

      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));
      setIsLoading(false);
    } catch (err) {
      const isAuthError =
        (err instanceof Error && (
          err.message.includes('UNAUTHORIZED') ||
          err.message.includes('401') ||
          err.message.includes('AUTH_REQUIRED')
        ));

      if (isAuthError) {
        setUser(null);
        localStorage.removeItem('user');
      }
      // On errors other than auth (network, timeout, 500…), keep cached user if available
      setIsLoading(false);

      if (err instanceof Error) {
        setError(err.message);
      }

      if (required && isAuthError) {
        const currentPath = window.location.pathname;
        if (
          currentPath === redirectTo ||
          currentPath.startsWith('/login') ||
          currentPath.startsWith('/signup') ||
          currentPath.startsWith('/forgot-password')
        ) {
          return;
        }
        const returnUrl = encodeURIComponent(currentPath);
        router.push(`${redirectTo}?returnUrl=${returnUrl}`);
      }
    }
  };

  useEffect(() => {
    fetchUser();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Instant update when profile is saved elsewhere
  useEffect(() => {
    const handler = (e: Event) => {
      const updated = (e as CustomEvent<User>).detail;
      if (updated) setUser(prev => prev ? { ...prev, ...updated } : updated);
    };
    window.addEventListener('user-profile-updated', handler);
    return () => window.removeEventListener('user-profile-updated', handler);
  }, []);

  return {
    user,
    isLoading,
    error,
    refetch: fetchUser,
  };
}

export function useIsAdmin(): boolean {
  const { user } = useSession();
  return user?.role === 'ADMIN';
}

export function useHasPlan(plan: 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO' | 'PREMIUM_PRO'): boolean {
  const { user } = useSession();
  return (user?.subscription.plan || '').toUpperCase() === plan;
}
