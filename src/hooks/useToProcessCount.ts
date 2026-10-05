"use client";

/**
 * Pastille « À traiter » de la coquille — APP-PERF-39 / APP-PERF-09.
 *
 * · Bloc secondaire : lu quand le navigateur est libre, après le contenu
 *   principal ; une panne ne bloque rien (la pastille reste vide ou garde sa
 *   dernière valeur).
 * · Identité : relu quand l'UTILISATEUR change (`userId`), pas quand l'objet
 *   session est remplacé à l'identique.
 * · Événements regroupés : `document-added` + `refresh-a-traiter` émis par
 *   la même action ne coûtent qu'une lecture ; une réponse plus ancienne
 *   qu'une valeur reçue ensuite (événement `update-a-traiter-count` porteur
 *   du nombre) est écartée.
 * · Plus de repli systématique vers l'ancienne route `/api/dashboard/a-traiter`
 *   sur TOUTE erreur : une session expirée, un délai ou une panne serveur
 *   n'ont rien à voir avec l'absence de la route, et ce repli doublait les
 *   requêtes au pire moment. La dernière valeur connue est conservée.
 * · Pas de cache client de 5 min : il rendait la pastille fausse après une
 *   action ; les lectures identiques en cours sont partagées (`dedupe`).
 */
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { createCoalescedRefresh, type CoalescedRefresh } from '@/lib/home/coalesced-refresh';
import { scheduleIdle } from '@/lib/shell/idle';

export const TO_PROCESS_REFRESH_EVENTS = ['document-added', 'refresh-a-traiter'] as const;
export const TO_PROCESS_COUNT_EVENT = 'update-a-traiter-count';

type ToProcessResponse = { total: number } | { items: unknown[] };

export function countFromToProcess(res: ToProcessResponse | null | undefined): number | null {
  if (!res || typeof res !== 'object') return null;
  if ('total' in res && typeof res.total === 'number') return res.total;
  if ('items' in res && Array.isArray(res.items)) return res.items.length;
  return null;
}

export function useToProcessCount(userId: number | null | undefined): number | null {
  const [count, setCount] = useState<number | null>(null);
  const coordinator = useRef<CoalescedRefresh | null>(null);

  useEffect(() => {
    if (!userId) {
      setCount(null);
      return;
    }
    const c = createCoalescedRefresh<ToProcessResponse>({
      windowMs: 400,
      load: ({ signal }) => apiClient.get<ToProcessResponse>('/api/to-process', { signal, dedupe: true }),
      apply: (res) => {
        const n = countFromToProcess(res);
        if (n !== null) setCount(n);
      },
      // Panne du compteur : sans effet sur le reste de la coquille.
      onError: () => undefined,
    });
    coordinator.current = c;

    // Première lecture quand le navigateur est libre ; annulée si l'on
    // quitte (déconnexion, changement d'utilisateur) avant son exécution.
    const cancelIdle = scheduleIdle(() => c.refreshNow(), { timeout: 3_000, fallbackDelay: 500 });

    const onEvent = () => c.invalidate();
    TO_PROCESS_REFRESH_EVENTS.forEach((e) => window.addEventListener(e, onEvent));

    const onCount = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'number') {
        // Valeur fournie par l'écran « À traiter » : elle prime sur toute
        // lecture encore en vol.
        c.supersede();
        setCount(detail);
      } else {
        c.invalidate();
      }
    };
    window.addEventListener(TO_PROCESS_COUNT_EVENT, onCount);

    return () => {
      cancelIdle();
      TO_PROCESS_REFRESH_EVENTS.forEach((e) => window.removeEventListener(e, onEvent));
      window.removeEventListener(TO_PROCESS_COUNT_EVENT, onCount);
      c.dispose();
      if (coordinator.current === c) coordinator.current = null;
    };
  }, [userId]);

  return count;
}
