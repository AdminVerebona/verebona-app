"use client";

/**
 * Reprise après erreur de chunk ou déploiement — APP-PERF-10.
 *
 * Écoute les erreurs globales et rejets non gérés de chargement de code et
 * les confie à la règle unique (`lib/pwa/chunk-recovery`) : au plus un
 * rechargement automatique par incident, jamais pendant une saisie ou un
 * envoi, jamais hors ligne. Sinon, un bandeau propose une reprise explicite.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  dismissRecovery,
  getRecoveryState,
  handleChunkError,
  isChunkLoadError,
  manualReload,
  onNetworkRestored,
  recoveryMessage,
  subscribeRecovery,
} from '@/lib/pwa/chunk-recovery';

const SERVER_STATE = { decision: null };

export function PwaRecovery() {
  const { decision } = useSyncExternalStore(subscribeRecovery, getRecoveryState, () => SERVER_STATE);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (!isChunkLoadError(event.error) && !isChunkLoadError(event.message ?? '')) return;
      event.preventDefault();
      handleChunkError();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!isChunkLoadError(event.reason)) return;
      event.preventDefault();
      handleChunkError();
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('online', onNetworkRestored);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('online', onNetworkRestored);
    };
  }, []);

  if (!decision) return null;
  const msg = recoveryMessage(decision);
  const bloquant = decision.action !== 'prompt' || decision.cause !== 'new-version';

  return (
    <div
      role={bloquant ? 'alert' : 'status'}
      aria-live={bloquant ? 'assertive' : 'polite'}
      className="fixed inset-x-3 bottom-[max(16px,env(safe-area-inset-bottom))] z-[10000] mx-auto flex max-w-lg flex-col gap-2 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 text-sm text-[color:var(--text-primary)] shadow-2xl md:bottom-6"
    >
      <p className="font-semibold">{msg.title}</p>
      <p className="text-[color:var(--text-muted)]">{msg.detail}</p>
      {(msg.button || decision.action === 'prompt') && (
        <div className="flex gap-2 pt-1">
          {msg.button && (
            <button
              type="button"
              onClick={manualReload}
              className="rounded-full bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              {msg.button}
            </button>
          )}
          {decision.action === 'prompt' && (
            <button
              type="button"
              onClick={dismissRecovery}
              className="rounded-full px-4 py-2 text-sm font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
            >
              Plus tard
            </button>
          )}
        </div>
      )}
    </div>
  );
}
