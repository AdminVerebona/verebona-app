'use client';
/**
 * Hook client de l'assistant — CDC §7.8 / §27.
 *
 * Gère l'état de la conversation, l'envoi de messages, la concurrence (une demande
 * active à la fois via AbortController — §7.8) et l'idempotence (clientRequestId).
 * Le client ne reconstruit JAMAIS d'URL d'action : il utilise `action.href` fourni
 * par le serveur (§27.1).
 */
import { useCallback, useRef, useState } from 'react';

export interface VerebonaAction {
  actionId: string;
  type: string;
  label: string;
  href: string | null;
  requiresConfirmation: boolean;
  analyticsCode: string;
}

export interface VerebonaMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: string;
  intent?: string;
  sourcesAvailable?: boolean;
  sourceCount?: number;
  actions?: VerebonaAction[];
  clarification?: {
    clarificationId: string;
    question: string;
    choices: Array<{ choiceId: string; label: string; secondaryLabel?: string }>;
  } | null;
}

export interface UseVerebonaState {
  messages: VerebonaMessage[];
  isLoading: boolean;
  error: string | null;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function useVerebona(pageContext?: Record<string, string>) {
  const [state, setState] = useState<UseVerebonaState>({ messages: [], isLoading: false, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || message.length > 2000) return;

    // Une seule demande active (§7.8) : on annule la précédente.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: VerebonaMessage = { id: newId(), role: 'user', content: message };
    setState((s) => ({ ...s, messages: [...s.messages, userMsg], isLoading: true, error: null }));

    try {
      const res = await fetch('/api/verebona/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, clientRequestId: newId(), pageContext }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setState((s) => ({ ...s, isLoading: false, error: err?.error?.message ?? 'Erreur' }));
        return;
      }
      const data = await res.json();
      const assistantMsg: VerebonaMessage = {
        id: data.messageId,
        role: 'assistant',
        content: data.answer,
        mode: data.mode,
        intent: data.intent,
        sourcesAvailable: data.sourcesAvailable,
        sourceCount: data.sourceCount,
        actions: data.actions ?? [],
        clarification: data.clarification ?? null,
      };
      setState((s) => ({ ...s, messages: [...s.messages, assistantMsg], isLoading: false }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // annulation volontaire
      setState((s) => ({ ...s, isLoading: false, error: 'Assistant indisponible' }));
    }
  }, [pageContext]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, isLoading: false }));
  }, []);

  const clear = useCallback(async () => {
    await fetch('/api/verebona/conversation', { method: 'DELETE' }).catch(() => null);
    setState({ messages: [], isLoading: false, error: null });
  }, []);

  const sendFeedback = useCallback(async (messageId: string, value: 'helpful' | 'not_helpful', reason?: string) => {
    await fetch(`/api/verebona/messages/${messageId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, reason }),
    }).catch(() => null);
  }, []);

  return { ...state, send, cancel, clear, sendFeedback };
}
