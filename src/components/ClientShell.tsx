"use client";

import { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ScrollToTop } from '@/components/ScrollToTop';
import { NavigationProgress } from '@/components/NavigationProgress';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import { WriteGuardProvider } from '@/contexts/WriteGuardContext';
import { SessionProvider } from '@/contexts/SessionContext';
import { EntitlementsProvider } from '@/hooks/useEntitlements';
import { PwaRecovery } from '@/components/pwa/PwaRecovery';

export function ClientShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Reprise bornée après erreur de chunk ou déploiement (APP-PERF-10) :
          remplace l'ancien rechargement systématique, sans limite ni
          protection des saisies, qui vidait tous les caches de l'origine. */}
      <PwaRecovery />
      <ServiceWorkerRegistration />
      {/* Le SEUL indicateur de navigation de l'application (APP-PERF-39). */}
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
