"use client";

/**
 * Faut-il proposer le guide de bienvenue ? — APP-PERF-05 / APP-PERF-39.
 *
 * La coquille chargeait, pour TOUT utilisateur, `/api/assets?limit=20` (dont
 * seul « au moins un bien ? » servait) et montait la fenêtre d'accueil — donc
 * demandait son code — à chaque page. Pire : la fenêtre s'ouvrait 600 ms
 * après le montage si la liste n'était pas encore arrivée, y compris pour un
 * compte qui avait déjà des biens.
 *
 * Désormais :
 *   · guide déjà vu sur cet appareil → aucune lecture, rien de monté ;
 *   · sinon, UNE lecture légère (`limit=1`), quand le navigateur est libre ;
 *     au moins un bien → guide marqué vu, rien de monté ; aucun bien →
 *     `'show'` ; échec → rien (un bloc secondaire ne s'impose pas sur une
 *     information inconnue ; il sera proposé à la prochaine visite).
 * Dépend de l'IDENTITÉ de l'utilisateur, pas de l'objet session.
 */
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { isWelcomeDismissed, markWelcomeDismissed } from '@/lib/onboarding/welcome-state';
import { scheduleIdle } from '@/lib/shell/idle';

export type WelcomeNeed = 'unknown' | 'show' | 'skip';

export function useWelcomeOnboardingNeed(userId: number | null | undefined): WelcomeNeed {
  const [need, setNeed] = useState<WelcomeNeed>('unknown');

  useEffect(() => {
    if (!userId) { setNeed('unknown'); return; }
    if (isWelcomeDismissed(userId)) { setNeed('skip'); return; }

    const controller = new AbortController();
    const cancelIdle = scheduleIdle(() => {
      apiClient
        .get<{ data?: unknown[]; total?: number }>('/api/assets?limit=1', { signal: controller.signal, dedupe: true })
        .then((res) => {
          const hasItems = (res.data?.length ?? 0) > 0 || (res.total ?? 0) > 0;
          if (hasItems) {
            markWelcomeDismissed(userId);
            setNeed('skip');
          } else {
            setNeed('show');
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setNeed('skip');
        });
    }, { timeout: 4_000, fallbackDelay: 800 });

    return () => {
      cancelIdle();
      controller.abort();
    };
  }, [userId]);

  return need;
}
