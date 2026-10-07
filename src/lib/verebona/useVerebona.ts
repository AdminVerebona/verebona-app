'use client';
/**
 * Hook client de l'assistant — CDC §7.8 / §27.
 *
 * Gère l'état de la conversation, l'envoi de messages, la concurrence (une demande
 * active à la fois via AbortController — §7.8) et l'idempotence (clientRequestId).
 * Le client ne reconstruit JAMAIS d'URL d'action : il utilise `action.href` fourni
 * par le serveur (§27.1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseWriteBlocked, type WriteBlockedInfo } from '@/lib/write-blocked';
import { toAssistantUiError, type AssistantUiError } from './error-messages';
import { currentPlatform, errorActions, errorAssistantMessage, isCancelledResponse, retryTarget, type UiResultGroup } from './assistant-ui';
import { enrichPageContext } from '@/lib/help-center/screens';
import { isBrowserOnline, OfflineQueue } from './offline';

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
  /**
   * État du plan (§9.6) : en attente (annulable), décision en cours d'envoi
   * (`DECIDING`), puis l'état rendu par le serveur — y compris après un
   * rechargement du fil.
   */
  status: VerebonaPlanStatus;
  /**
   * Fin de la fenêtre « Annuler » d'une action exécutée et réversible
   * (15 minutes, décision produit) ; null ou absent : pas de bouton.
   */
  undoUntil?: string | null;
}

export type VerebonaPlanStatus =
  | 'PENDING_CONFIRMATION' | 'DECIDING' | 'EXECUTING' | 'EXECUTED' | 'PARTIAL' | 'FAILED'
  | 'CANCELLED' | 'EXPIRED' | 'REFUSED' | 'HANDLED'
  /** Action exécutée puis annulée par l'utilisateur (« Annuler » dans les 15 minutes). */
  | 'UNDONE';

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
  /** Cartes de résultats groupées par type (§11.3, §22.3). */
  resultGroups?: UiResultGroup[] | null;
  /**
   * Chronologie structurée (CDC 15 T2-35) : « date · libellé », avec lien
   * vers l'objet quand il est connu. Absente : la réponse texte suffit.
   */
  events?: Array<{ date: string | null; text: string; href: string | null }> | null;
  /**
   * Erreur affichée DANS le fil (§4.2, §27.11) : libellé Verebona, et les
   * actions « Réessayer » / « Ouvrir l'aide » portées par `actions`.
   */
  error?: AssistantUiError | null;
  /** §30.6 : question en attente de connexion, envoyée au retour du réseau. */
  pendingOffline?: boolean;
  /** §27.11 : codes informatifs joints à la réponse (non bloquants). */
  notices?: Array<{ code: string; message: string }>;
  /**
   * Échange construit dans l'interface, sans appel au serveur (Direction D
   * v2 §3.2) : sujet de la mascotte ouvert dans l'espace de réponse, choix
   * « Que souhaitez-vous ajouter ? ». Jamais enregistré dans le fil.
   */
  local?: VerebonaLocalAnswer;
}

/** Réponse locale : mêmes briques que les autres (phrase, objets, actions). */
export interface VerebonaLocalAnswer {
  kind?: import('./space').AnswerKind;
  tone?: 'neutral' | 'success';
  summary?: string;
  objects?: import('./space').SpaceObject[];
  /** Actions pilules : `id` retrouve le gestionnaire côté interface. */
  actions?: Array<{ id: string; label: string; primary?: boolean }>;
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
  /** Début de la dernière réponse du fil (« Demandes précédentes », §8). */
  lastAnswer?: string | null;
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
  result_groups_json?: UiResultGroup[] | null;
  /** Chronologie conservée (R1, 0228) ; liens revérifiés par le serveur. */
  timeline_events_json?: Array<{ date: string | null; text: string; href: string | null }> | null;
}
const fromHistory = (r: HistoryRow): VerebonaMessage => ({
  id: String(r.id),
  role: r.role,
  content: r.content ?? '',
  mode: r.mode ?? undefined,
  intent: r.intent ?? undefined,
  sourcesAvailable: (r.source_count ?? 0) > 0,
  sourceCount: r.source_count ?? 0,
  resultGroups: Array.isArray(r.result_groups_json) ? r.result_groups_json : null,
  // R1 : la chronologie relue s'affiche comme à la réception (même rendu).
  events: Array.isArray(r.timeline_events_json) ? r.timeline_events_json : null,
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

export function useVerebona(rawPageContext?: Record<string, string>, options: UseVerebonaOptions = {}) {
  // Contexte de page ENRICHI (§13.3, §27.1) : le layout n'envoie que la
  // route ; le bien / document ouverts en sont extraits (« ce bien » sur
  // `/assets/42`), avec la plateforme (choix des articles d'aide, T2-05).
  // Le serveur revalide chaque identifiant.
  const pageContext = useMemo(() => enrichPageContext(rawPageContext, currentPlatform()), [rawPageContext]);
  const onWriteBlockedRef = useRef(options.onWriteBlocked);
  onWriteBlockedRef.current = options.onWriteBlocked;
  const [state, setState] = useState<UseVerebonaState>({ messages: [], isLoading: false, error: null });
  const [threads, setThreads] = useState<VerebonaThread[]>([]);
  const [conversationId, setConversationIdState] = useState<number | null>(null);
  const conversationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Identifiant client de la demande en cours : l'annulation le transmet au serveur. */
  const pendingRequestRef = useRef<string | null>(null);
  /** Contexte structuré de chaque question envoyée, pour « Réessayer ». */
  const contextByMessage = useRef(new Map<string, Record<string, string> | undefined>());
  const messagesRef = useRef<VerebonaMessage[]>([]);
  messagesRef.current = state.messages;
  // §30.6 : connexion du navigateur, et questions en attente de réseau.
  const [online, setOnline] = useState(true);
  const offlineQueue = useRef(new OfflineQueue());
  // §27.6 : curseur des messages plus anciens du fil (null : tout est chargé).
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

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
    // Pagination par curseur (§27.6) : la page la plus récente d'abord.
    setOlderCursor(typeof data.nextCursor === 'number' ? data.nextCursor : null);
    const messages: VerebonaMessage[] = (data.messages ?? []).map(fromHistory);
    // Commandes proposées : restituées sur le message qui les présentait,
    // avec leur état réel (une proposition en attente reste annulable).
    const plans: Array<VerebonaCommandPlan & { messageId: number }> = Array.isArray(data.commandPlans) ? data.commandPlans : [];
    for (const { messageId, ...plan } of plans) {
      const m = messages.find((x) => x.id === String(messageId));
      if (m) m.commandPlan = plan;
    }
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
  /**
   * Rend `true` si une réponse (même en erreur affichée) est arrivée,
   * `false` si la question n'a pas abouti : l'appelant peut alors rendre le
   * texte saisi (§7.6, saisie conservée si l'appel échoue).
   */
  const send = useCallback(async (
    text: string,
    extraContext?: Record<string, string>,
    /**
     * Renvoi d'une question en attente (§30.6) : même identifiant de requête
     * (idempotence §31.9) et même message du fil, qui cesse d'être « en attente ».
     */
    reprise?: { clientRequestId: string; userMessageId: string },
  ): Promise<boolean> => {
    const message = text.trim();
    if (!message || message.length > 2000) return false;

    // §30.6 : hors ligne, la question n'est pas perdue — elle reste dans le
    // fil, « en attente de connexion », et part au retour du réseau.
    if (!isBrowserOnline()) {
      if (reprise) {
        // Toujours hors ligne au moment du renvoi : la question reste en attente.
        offlineQueue.current.enqueue({ messageId: reprise.userMessageId, text: message, context: extraContext, clientRequestId: reprise.clientRequestId });
        return true;
      }
      const enAttente: VerebonaMessage = { id: newId(), role: 'user', content: message, pendingOffline: true };
      contextByMessage.current.set(enAttente.id, extraContext);
      offlineQueue.current.enqueue({ messageId: enAttente.id, text: message, context: extraContext, clientRequestId: newId() });
      setState((s) => ({ ...s, messages: [...s.messages, enAttente] }));
      return true;
    }

    // Une seule demande active (§7.8) : on annule la précédente.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: VerebonaMessage = { id: reprise?.userMessageId ?? newId(), role: 'user', content: message };
    contextByMessage.current.set(userMsg.id, extraContext);
    setState((s) => ({
      ...s,
      // Renvoi : le message déjà affiché n'est plus « en attente » (pas de doublon).
      messages: reprise
        ? s.messages.map((m) => (m.id === userMsg.id ? { ...m, pendingOffline: false } : m))
        : [...s.messages, userMsg],
      isLoading: true, error: null,
    }));

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

    // Identifiant de requête : celui d'origine pour un renvoi (§30.6, §31.9).
    const clientRequestId = reprise?.clientRequestId ?? newId();
    pendingRequestRef.current = clientRequestId;
    try {
      const res = await fetch('/api/verebona/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          clientRequestId,
          pageContext: extraContext ? { ...(pageContext ?? {}), ...extraContext } : pageContext,
          conversationId: conversationRef.current,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Demande annulée (Stop, fermeture du tiroir) : rien n'est affiché.
        if (isCancelledResponse(err)) return false;
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
          return false;
        }
        if (res.status === 404) {
          // Le fil n'existe plus (effacé ailleurs, expiré) : la question
          // n'est pas envoyée dans un autre fil à l'insu de l'utilisateur.
          setConversationId(null);
          void refreshThreads();
        }
        afficherErreur(toAssistantUiError(err, res.status));
        return false;
      }
      const data = await res.json();
      if (isCancelledResponse(data)) return false;
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
        resultGroups: Array.isArray(data.resultGroups) ? data.resultGroups : null,
        events: Array.isArray(data.events) ? data.events : null,
        notices: Array.isArray(data.notices) ? data.notices : undefined,
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
      return !assistantMsg.error;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false; // annulation volontaire
      // Coupure réseau pendant l'envoi (§30.6) : la question reste affichée,
      // en attente, et sera renvoyée au retour de la connexion.
      if (!isBrowserOnline()) {
        offlineQueue.current.enqueue({ messageId: userMsg.id, text: message, context: extraContext, clientRequestId });
        setState((s) => ({
          ...s, isLoading: false, error: null,
          messages: s.messages.map((m) => (m.id === userMsg.id ? { ...m, pendingOffline: true } : m)),
        }));
        return true;
      }
      afficherErreur(toAssistantUiError({ error: { code: 'NETWORK_ERROR' } }));
      return false;
    } finally {
      if (pendingRequestRef.current === clientRequestId) pendingRequestRef.current = null;
    }
  }, [pageContext, refreshThreads, setConversationId]);

  // ── Hors ligne (§30.6) ────────────────────────────────────────────────
  // État initial lu au montage ; au retour du réseau, les questions en
  // attente partent dans l'ordre, chacune avec son identifiant de requête
  // D'ORIGINE : une question déjà reçue par le serveur avant la coupure est
  // reconnue (idempotence §31.9) et n'est pas traitée une seconde fois.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOnline(isBrowserOnline());
    const horsLigne = () => setOnline(false);
    const enLigne = () => {
      setOnline(true);
      void (async () => {
        for (const q of offlineQueue.current.drain()) {
          await sendRef.current(q.text, q.context, { clientRequestId: q.clientRequestId, userMessageId: q.messageId });
        }
      })();
    };
    window.addEventListener('offline', horsLigne);
    window.addEventListener('online', enLigne);
    return () => {
      window.removeEventListener('offline', horsLigne);
      window.removeEventListener('online', enLigne);
    };
  }, []);

  /**
   * Messages plus anciens du fil (§27.6) : page précédente, par curseur,
   * ajoutée en tête du fil.
   */
  const loadOlder = useCallback(async () => {
    const id = conversationRef.current;
    if (!id || olderCursor == null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/verebona/conversation?conversationId=${id}&cursor=${olderCursor}`).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (!data || data.conversationId !== id) return;
      const anciens: VerebonaMessage[] = (data.messages ?? []).map(fromHistory);
      setOlderCursor(typeof data.nextCursor === 'number' ? data.nextCursor : null);
      setState((s) => {
        const vus = new Set(s.messages.map((m) => m.id));
        return { ...s, messages: [...anciens.filter((m) => !vus.has(m.id)), ...s.messages] };
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [olderCursor, loadingOlder]);

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
        resultGroups: Array.isArray(data.resultGroups) ? data.resultGroups : null,
        events: Array.isArray(data.events) ? data.events : null,
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
  const decidePlan = useCallback(async (planId: string, decision: 'confirm' | 'cancel' | 'undo') => {
    const planStatus = (status: VerebonaPlanStatus, patch: Partial<VerebonaCommandPlan> = {}) => (m: VerebonaMessage): VerebonaMessage => (
      m.commandPlan?.planId === planId ? { ...m, commandPlan: { ...m.commandPlan, ...patch, status } } : m
    );
    // Précédent état, rétabli si la décision n'a pas pu être transmise.
    const avant = messagesRef.current.find((m) => m.commandPlan?.planId === planId)?.commandPlan?.status ?? 'PENDING_CONFIRMATION';
    // Boutons désactivés pendant l'envoi : un double clic n'envoie qu'une décision.
    setState((s) => ({ ...s, isLoading: true, error: null, messages: s.messages.map(planStatus('DECIDING')) }));
    const res = await fetch(`/api/verebona/commands/${encodeURIComponent(planId)}/${decision}`, { method: 'POST' }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    // État final rendu par le serveur (annulée, expirée, exécutée…) ; à
    // défaut (réseau), la proposition redevient utilisable.
    // Refus de l'interrupteur (403 sans état) : la proposition reste annulable.
    const serveur = (data?.status ?? null) as VerebonaPlanStatus | null;
    const retour: VerebonaPlanStatus = avant === 'DECIDING' ? 'PENDING_CONFIRMATION' : avant;
    const etat: VerebonaPlanStatus = serveur ?? (!res || res.status === 403 ? retour : 'HANDLED');
    // Fenêtre « Annuler » : ouverte par une confirmation réussie ; fermée
    // définitivement par un refus d'annulation (délai dépassé, action
    // irréversible, objet modifié depuis) — le bouton disparaît.
    const patch: Partial<VerebonaCommandPlan> = decision === 'confirm' && res?.ok
      ? { undoUntil: typeof data?.undoUntil === 'string' ? data.undoUntil : null }
      : decision === 'undo' && res && (res.ok || res.status === 409 || res.status === 404) ? { undoUntil: null } : {};
    setState((s) => ({ ...s, messages: s.messages.map(planStatus(etat, patch)) }));
    let texte: string;
    if (!res || !res.ok) {
      texte = data?.error?.message ?? 'Action impossible pour le moment.';
    } else if (decision === 'undo') {
      // Annulation rejouée (déjà défaite) : pas de second message dans le fil.
      if (data.alreadyHandled) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }
      texte = data.message ?? 'J’ai annulé cette action.';
      const cibles = (data.entities ?? []) as Array<{ type: string; id: number }>;
      if (typeof window !== 'undefined') {
        if (cibles.some((e) => e.type === 'agenda_item')) window.dispatchEvent(new CustomEvent('agenda-mutated'));
        for (const e of cibles) {
          if (e.type === 'asset') window.dispatchEvent(new CustomEvent('asset-details-updated', { detail: { assetId: e.id } }));
        }
        window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
      }
    } else if (decision === 'cancel') {
      texte = data.message ?? 'D’accord, j’ai annulé cette action : rien n’a été modifié.';
      // Annulation rejouée (déjà annulée) : pas de second message dans le fil.
      if (data.alreadyHandled) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }
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
      // Texte de l'issue fourni par le serveur : le même que celui enregistré
      // dans le fil (rechargement identique).
      texte = data.message ?? (lignes.length > 1
        ? `${data.summary}\n${lignes.map((r) => `• ${r.status === 'SUCCESS' ? '✓' : r.status === 'SKIPPED_DEPENDENCY' ? '↷' : '✗'} ${r.message}`).join('\n')}`
        : (data.summary ?? 'Action effectuée.'));
    }
    setState((s) => ({ ...s, isLoading: false, messages: [...s.messages, { id: newId(), role: 'assistant', content: texte }] }));
  }, []);

  /** Nouveau fil, sans mémoire des autres. */
  const newConversation = useCallback(async () => {
    abortRef.current?.abort();
    const res = await fetch('/api/verebona/conversations', { method: 'POST' }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => ({})) : {};
    setConversationId(data.conversationId ?? null);
    setOlderCursor(null);
    setState({ messages: [], isLoading: false, error: null });
    void refreshThreads();
  }, [refreshThreads, setConversationId]);

  const selectConversation = useCallback(async (id: number) => {
    if (id === conversationRef.current) return;
    await loadThread(id);
  }, [loadThread]);

  /**
   * Annulation EFFECTIVE (§7.8, §9.7, CA-22) : l'attente est abandonnée ET le
   * serveur est prévenu (DELETE par identifiant client — la réservation existe
   * dès le début du traitement). Le serveur n'enregistre alors pas la
   * réponse : elle ne réapparaîtra pas au rechargement.
   */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    const id = pendingRequestRef.current;
    pendingRequestRef.current = null;
    if (id) void fetch(`/api/verebona/requests/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    setState((s) => ({ ...s, isLoading: false }));
  }, []);

  /** Efface le fil courant ; les autres fils sont conservés. */
  const clear = useCallback(async () => {
    const id = conversationRef.current;
    const url = id ? `/api/verebona/conversation?conversationId=${id}` : '/api/verebona/conversation';
    await fetch(url, { method: 'DELETE' }).catch(() => null);
    setConversationId(null);
    setOlderCursor(null);
    setState({ messages: [], isLoading: false, error: null });
    void refreshThreads();
  }, [refreshThreads, setConversationId]);

  /**
   * Efface définitivement UN fil (§24.4), courant ou archivé. Le fil courant
   * passe par `clear` (l'espace repart vide) ; un autre fil disparaît de la
   * liste sans toucher à l'échange en cours.
   */
  const deleteThread = useCallback(async (id: number) => {
    if (id === conversationRef.current) { await clear(); return; }
    await fetch(`/api/verebona/conversation?conversationId=${id}`, { method: 'DELETE' }).catch(() => null);
    void refreshThreads();
  }, [clear, refreshThreads]);

  /**
   * Ajoute un échange construit par l'interface (question + réponse locale).
   * Aucune requête : il vit dans l'affichage jusqu'au prochain changement de fil.
   */
  const appendLocal = useCallback((question: string, answer: VerebonaLocalAnswer & { content: string }) => {
    const { content, ...local } = answer;
    setState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: newId(), role: 'user', content: question },
        { id: newId(), role: 'assistant', content, local },
      ],
    }));
  }, []);

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
    /** §30.6 : le navigateur est-il en ligne ? */
    online,
    /** §27.6 : reste-t-il des messages plus anciens à charger ? */
    hasOlder: olderCursor != null,
    loadingOlder,
    loadOlder,
    send,
    retry,
    cancel,
    clear,
    deleteThread,
    sendFeedback,
    appendLocal,
    answerClarification,
    confirmPlan: (planId: string) => decidePlan(planId, 'confirm'),
    cancelPlan: (planId: string) => decidePlan(planId, 'cancel'),
    /** « Annuler » une action exécutée, dans les 15 minutes (plans réversibles seulement). */
    undoPlan: (planId: string) => decidePlan(planId, 'undo'),
    newConversation,
    selectConversation,
  };
}
