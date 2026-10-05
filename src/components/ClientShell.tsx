"use client";

import { ReactNode, useEffect } from 'react';
import { Toaster } from 'sonner';
import { ScrollToTop } from '@/components/ScrollToTop';
import { NavigationProgress } from '@/components/NavigationProgress';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import { WriteGuardProvider } from '@/contexts/WriteGuardContext';
import { SessionProvider } from '@/contexts/SessionContext';
import { EntitlementsProvider } from '@/hooks/useEntitlements';

function ChunkErrorHandler() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const msg = event.message ?? '';
      const isChunk = event.error?.name === 'ChunkLoadError'
        || msg.includes('Failed to load chunk')
        || msg.includes('Loading chunk')
        || msg.includes('dynamically imported module');
      if (isChunk) {
        event.preventDefault();
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
          setTimeout(() => window.location.reload(), 300);
        } else {
          window.location.reload();
        }
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message ?? String(event.reason ?? '');
      const isChunk = event.reason?.name === 'ChunkLoadError'
        || msg.includes('Failed to load chunk')
        || msg.includes('Loading chunk')
        || msg.includes('dynamically imported module');
      if (isChunk) {
        event.preventDefault();
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
          setTimeout(() => window.location.reload(), 300);
        } else {
          window.location.reload();
        }
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return null;
}

export function ClientShell({ children }: { children: ReactNode }) {
  return (
    <>
      <ChunkErrorHandler />
      <ServiceWorkerRegistration />
      <NavigationProgress />
      {/* Session et droits : UN fournisseur chacun pour toute l'application
          (APP-PERF-04, APP-PERF-12) — une lecture partagée de l'identité et
          des droits, quels que soient les composants montés.
          Garde d'écriture montée à la racine : une seule fenêtre pour les
          douze actions qui peuvent être refusées. La monter plus bas en
          ouvrirait plusieurs, potentiellement en même temps. */}
      <SessionProvider>
        <EntitlementsProvider>
          <WriteGuardProvider>{children}</WriteGuardProvider>
        </EntitlementsProvider>
      </SessionProvider>
      <Toaster closeButton position="top-center" richColors />
      <ScrollToTop />
    </>
  );
}
