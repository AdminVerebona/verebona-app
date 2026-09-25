'use client';
/**
 * Hook client de l'assistant — CDC §7.8 / §27.
 *
 * Gère l'état de la conversation, l'envoi de messages, la concurrence (une demande
 * active à la fois via AbortController — §7.8) et l'idempotence (clientRequestId).
 * Le client ne reconstruit JAMAIS d'URL d'action : il utilise `action.href` fourni
 * par le serveur (§27.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseWriteBlocked, type WriteBlockedInfo } from '@/lib/write-blocked';
import { toAssistantUiError, type AssistantUiError } from './error-messages';
import { errorActions, errorAssistantMessage, retryTarget } from './assistant-ui';

export interface VerebonaAction {
  actionId: string;
  type: string;
  label: string;
  href: string | null;
  requiresConfirmation: boolean;
  analyticsCode: string;
}

/** Commande préparée par l'assistant, à confirmer explicitement. */
export interface VerebonaCommandPlan {
  planId: string;
  summary: string;
  expiresAt: string;
  actions: Array<{ actionId: string; label: string; preview: string; effects: string[]; dependsOn: string[] }>;
  /** État côté client : en attente, ou traité (confirmé / annulé). */
  status: 'PENDING_CONFIRMATION' | 'HANDLED' | 'CANCELLED';
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
  commandPlan?: VerebonaCommandPlan | null;
  /**
   * Erreur affichée DANS le fil (§4.2, §27.11) : libellé Verebona, et les
   * actions « Réessayer » / « Ouvrir l'aide » portées par `actions`.
   */
  error?: AssistantUiError | null;
}

export interface UseVerebonaState {
  messages: VerebonaMessage[];
  isLoading: boolean;
  error: string | null;
}

/** Fil de conversation de l'utilisateur (privé, y compris en Duo). */
export interface VerebonaThread {
  id: number;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

/**
 * Dernier fil ouvert, pour le rouvrir après un rechargement. Simple confort
 * d'affichage : la source de vérité reste le serveur, qui contrôle la
 * propriété du fil et retombe sur le plus récent si celui-ci n'existe plus.
 */
const THREAD_KEY = 'verebona:conversationId';
function rememberThread(id: number | null) {
  try {
    if (id == null) window.localStorage.removeItem(THREAD_KEY);
    else window.localStorage.setItem(THREAD_KEY, String(id));
  } catch { /* stockage indisponible : sans effet */ }
}
function recallThread(): number | null {
  try {
    const v = Number(window.localStorage.getItem(THREAD_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch { return null; }
}

interface HistoryRow {
  id: number; role: 'user' | 'assistant'; content: string | null;
  intent: string | null; mode: string | null; source_count?: number;
}
const fromHistory = (r: HistoryRow): VerebonaMessage => ({
  id: String(r.id),
  role: r.role,
  content: r.content ?? '',
  mode: r.mode ?? undefined,
  intent: r.intent ?? undefined,
  sourcesAvailable: (r.source_count ?? 0) > 0,
  sourceCount: r.source_count ?? 0,
});

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export interface UseVerebonaOptions {
  /** Appelé quand le serveur refuse la question pour une raison de droits. */
  onWriteBlocked?: (info: WriteBlockedInfo) => void;
}

export function useVerebona(pageContext?: Record<string, string>, options: UseVerebonaOptions = {}) {
  const onWriteBlockedRef = useRef(options.onWriteBlocked);
  onWriteBlockedRef.current = options.onWriteBlocked;
  const [state, setState] = useState<UseVerebonaState>({ messages: [], isLoading: false, error: null });
  const [threads, setThreads] = useState<VerebonaThread[]>([]);
  const [conversationId, setConversationIdState] = useState<number | null>(null);
  const conversationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Contexte structuré de chaque question envoyée, pour « Réessayer ». */
  const contextByMessage = useRef(new Map<string, Record<string, string> | undefined>());
  const messagesRef = useRef<VerebonaMessage[]>([]);
  messagesRef.current = state.messages;

  const setConversationId = useCallback((id: number | null) => {
    conversationRef.current = id;
    setConversationIdState(id);
    rememberThread(id);
  }, []);

  const refreshThreads = useCallback(async (): Promise<VerebonaThread[]> => {
    const res = await fetch('/api/verebona/conversations').catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => ({})) : {};
    const list: VerebonaThread[] = data.conversations ?? [];
    setThreads(list);
    return list;
  }, []);

  /** Charge l'historique d'un fil (ou du plus récent si `id` est nul). */
  const loadThread = useCallback(async (id: number | null) => {
    abortRef.current?.abort();
    const url = id ? `/api/verebona/conversation?conversationId=${id}` : '/api/verebona/conversation';
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) {
      // Fil disparu (effacé, expiré) : on repart du plus récent.
      if (id) return loadThread(null);
      setConversationId(null);
      setState({ messages: [], isLoading: false, error: null });
      return;
    }
    const data = await res.json().catch(() => ({ conversationId: null, messages: [] }));
    setConversationId(data.conversationId ?? null);
    const messages: VerebonaMessage[] = (data.messages ?? []).map(fromHistory);
    // Clarification encore ouverte : ses choix reviennent sur la dernière
    // réponse de l'assistant.
    if (data.clarification) {
      const last = [...messages].reverse().find((m) => m.role === 'assistant');
      if (last) last.clarification = data.clarification;
    }
    setState({ messages, isLoading: false, error: null });
  }, [setConversationId]);

  // Reprise au montage : le dernier fil ouvert s'il existe toujours, sinon le
  // plus récent. Après une déconnexion, les fils restent disponibles côté
  // serveur, séparément.
  useEffect(() => {
    void (async () => {
      const list = await refreshThreads();
      const remembered = recallThread();
      await loadThread(remembered && list.some((t) => t.id === remembered) ? remembered : null);
    })();
  }, [refreshThreads, loadThread]);

  /**
   * `extraContext` : contexte structuré transmis par l'appelant — question
   * rapide de la mascotte (CDC Mascotte SEC-005 : intention, bien). Il
   * complète le contexte de page ; le serveur revalide tout identifiant.
   */
  const send = useCallback(async (text: string, extraContext?: Record<string, string>) => {
    const message = text.trim();
    if (!message || message.length > 2000) return;

    // Une seule demande active (§7.8) : on annule la précédente.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: VerebonaMessage = { id: newId(), role: 'user', content: message };
    contextByMessage.current.set(userMsg.id, extraContext);
    setState((s) => ({ ...s, messages: [...s.messages, userMsg], isLoading: true, error: null }));

    // Jamais d'impasse (§4.2) : toute erreur devient un message de
    // l'assistant, avec « Réessayer » et « Ouvrir l'aide ».
    const afficherErreur = (e: AssistantUiError) => {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: e.message,
        messages: [...s.messages, errorAssistantMessage(e, newId())],
      }));
    };

    try {
      const res = await fetch('/api/verebona/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          clientRequestId: newId(),
          pageContext: extraContext ? { ...(pageContext ?? {}), ...extraContext } : pageContext,
          conversationId: conversationRef.current,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Refus de droits (essai terminé) : la question n'a pas été posée.
        // On la retire du fil plutôt que d'afficher une erreur technique.
        const refus = res.status === 403 ? parseWriteBlocked(err) : null;
        if (refus) {
          setState((s) => ({
            ...s,
            messages: s.messages.filter((m) => m.id !== userMsg.id),
            isLoading: false,
            error: null,
          }));
          onWriteBlockedRef.current?.(refus);
          return;
        }
        if (res.status === 404) {
          // Le fil n'existe plus (effacé ailleurs, expiré) : la question
          // n'est pas envoyée dans un autre fil à l'insu de l'utilisateur.
          setConversationId(null);
          void refreshThreads();
        }
        afficherErreur(toAssistantUiError(err, res.status));
        return;
      }
      const data = await res.json();
      if (data.conversationId && data.conversationId !== conversationRef.current) {
        setConversationId(data.conversationId);
      }
      void refreshThreads();
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
        commandPlan: data.commandPlan ? { ...data.commandPlan, status: 'PENDING_CONFIRMATION' } : null,
      };
      // Réponse `status: 'error'` (§27.11) : le libellé et les suites
      // viennent de `error-messages`, jamais d'un texte technique.
      if (data.status === 'error') {
        const e = toAssistantUiError(data, res.status);
        assistantMsg.content = e.message;
        assistantMsg.error = e;
        if (!assistantMsg.actions?.length) assistantMsg.actions = errorActions(e, assistantMsg.id);
      }
      setState((s) => ({ ...s, messages: [...s.messages, assistantMsg], isLoading: false, error: assistantMsg.error?.message ?? null }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // annulation volontaire
      afficherErreur(toAssistantUiError({ error: { code: 'NETWORK_ERROR' } }));
    }
  }, [pageContext, refreshThreads, setConversationId]);

  /**
   * « Réessayer » (RETRY_REQUEST, §27.11) : renvoie la dernière question
   * précédant `fromMessageId` (le message d'erreur ou la réponse), avec un
   * NOUVEL identifiant de requête — le même serait reconnu par l'idempotence
   * et rendrait la réponse en erreur déjà enregistrée. Le message d'erreur et
   * la question d'origine sont retirés du fil pour ne pas la dupliquer.
   */
  const retry = useCallback(async (fromMessageId?: string) => {
    const cible = retryTarget(messagesRef.current, fromMessageId);
    if (!cible) return;
    const ctx = contextByMessage.current.get(cible.userMessageId);
    setState((s) => ({
      ...s,
      messages: s.messages.filter((m) => m.id !== cible.userMessageId && !(fromMessageId && m.id === fromMessageId && m.error)),
    }));
    await send(cible.text, ctx);
  }, [send]);

  /**
   * Choix d'un candidat de clarification : la demande initiale est reprise
   * côté serveur avec ce choix (pas de nouvelle question tapée).
   */
  const answerClarification = useCallback(async (
    clarificationId: string,
    choice: { choiceId: string; label: string; secondaryLabel?: string },
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const userMsg: VerebonaMessage = {
      id: newId(), role: 'user',
      content: choice.secondaryLabel ? `${choice.label} — ${choice.secondaryLabel}` : choice.label,
    };
    setState((s) => ({
      ...s,
      // Les boutons de la question disparaissent : un choix ne se rejoue pas.
      messages: [...s.messages.map((m) => (m.clarification?.clarificationId === clarificationId ? { ...m, clarification: null } : m)), userMsg],
      isLoading: true,
      error: null,
    }));
    try {
      const res = await fetch(`/api/verebona/clarifications/${encodeURIComponent(clarificationId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choiceId: choice.choiceId, conversationId: conversationRef.current }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const text = data?.error?.message ?? 'Reformulez votre demande.';
        setState((s) => ({ ...s, isLoading: false, messages: [...s.messages, { id: newId(), role: 'assistant', content: text }] }));
        return;
      }
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
        commandPlan: data.commandPlan ? { ...data.commandPlan, status: 'PENDING_CONFIRMATION' } : null,
      };
      setState((s) => ({ ...s, messages: [...s.messages, assistantMsg], isLoading: false }));
      void refreshThreads();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const err = toAssistantUiError({ error: { code: 'NETWORK_ERROR' } });
      // Un choix de clarification ne se rejoue pas : pas de « Réessayer ».
      setState((s) => ({
        ...s, isLoading: false, error: err.message,
        messages: [...s.messages, errorAssistantMessage({ ...err, recoverable: false }, newId())],
      }));
    }
  }, [refreshThreads]);

  /**
   * Confirmation explicite d'une commande préparée : seul l'identifiant du
   * plan part au serveur, qui exécute ce qui a été présenté — rien d'autre.
   */
  const decidePlan = useCallback(async (planId: string, decision: 'confirm' | 'cancel') => {
    setState((s) => ({
      ...s,
      isLoading: true,
      error: null,
      messages: s.messages.map((m) => (m.commandPlan?.planId === planId
        ? { ...m, commandPlan: { ...m.commandPlan, status: decision === 'cancel' ? 'CANCELLED' as const : 'HANDLED' as const } }
        : m)),
    }));
    const res = await fetch(`/api/verebona/commands/${encodeURIComponent(planId)}/${decision}`, { method: 'POST' }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    let texte: string;
    if (!res || !res.ok) {
      texte = data?.error?.message ?? 'Action impossible pour le moment.';
    } else if (decision === 'cancel') {
      texte = 'D’accord, je n’ai rien modifié.';
    } else {
      const lignes = (data.results ?? []) as Array<{ status: string; message: string; entity?: { type: string; id: number } | null }>;
      // Les écrans ouverts sous l'assistant se remettent à jour.
      if (typeof window !== 'undefined') {
        if (lignes.some((r) => r.status === 'SUCCESS' && r.entity?.type === 'agenda_item')) window.dispatchEvent(new CustomEvent('agenda-mutated'));
        for (const r of lignes) {
          if (r.status === 'SUCCESS' && r.entity?.type === 'asset') {
            window.dispatchEvent(new CustomEvent('asset-details-updated', { detail: { assetId: r.entity.id } }));
          }
        }
        window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
      }
      texte = lignes.length > 1
        ? `${data.summary}\n${lignes.map((r) => `• ${r.status === 'SUCCESS' ? '✓' : r.status === 'SKIPPED_DEPENDENCY' ? '↷' : '✗'} ${r.message}`).join('\n')}`
        : (data.summary ?? 'Action effectuée.');
    }
    setState((s) => ({ ...s, isLoading: false, messages: [...s.messages, { id: newId(), role: 'assistant', content: texte }] }));
  }, []);

  /** Nouveau fil, sans mémoire des autres. */
  const newConversation = useCallback(async () => {
    abortRef.current?.abort();
    const res = await fetch('/api/verebona/conversations', { method: 'POST' }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => ({})) : {};
    setConversationId(data.conversationId ?? null);
    setState({ messages: [], isLoading: false, error: null });
    void refreshThreads();
  }, [refreshThreads, setConversationId]);

  const selectConversation = useCallback(async (id: number) => {
    if (id === conversationRef.current) return;
    await loadThread(id);
  }, [loadThread]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, isLoading: false }));
  }, []);

  /** Efface le fil courant ; les autres fils sont conservés. */
  const clear = useCallback(async () => {
    const id = conversationRef.current;
    const url = id ? `/api/verebona/conversation?conversationId=${id}` : '/api/verebona/conversation';
    await fetch(url, { method: 'DELETE' }).catch(() => null);
    setConversationId(null);
    setState({ messages: [], isLoading: false, error: null });
    void refreshThreads();
  }, [refreshThreads, setConversationId]);

  /** Efface tout l'historique de l'utilisateur. */
  const clearAll = useCallback(async () => {
    await fetch('/api/verebona/conversation', { method: 'DELETE' }).catch(() => null);
    setConversationId(null);
    setState({ messages: [], isLoading: false, error: null });
    setThreads([]);
  }, [setConversationId]);

  const sendFeedback = useCallback(async (messageId: string, value: 'helpful' | 'not_helpful', reason?: string) => {
    await fetch(`/api/verebona/messages/${messageId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, reason }),
    }).catch(() => null);
  }, []);

  return {
    ...state,
    conversationId,
    threads,
    send,
    retry,
    cancel,
    clear,
    clearAll,
    sendFeedback,
    answerClarification,
    confirmPlan: (planId: string) => decidePlan(planId, 'confirm'),
    cancelPlan: (planId: string) => decidePlan(planId, 'cancel'),
    newConversation,
    selectConversation,
  };
}
