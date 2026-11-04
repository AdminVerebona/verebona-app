"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { isSettledProcessingStatus } from '@/lib/ai/processing-status';
import { ANALYSIS_DONE_CUE_MS, ANALYSIS_FOLLOW_POLL_MS, analysisStatusUrl } from '@/lib/notifications/document-notification-policy';

const TERMINAL_STATES = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'ANALYSIS_FAILED'];
const SUCCESS_STATES = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED'];
/**
 * Délai entre deux polls de vérification (quand une analyse est en cours).
 * Lot 108I : ce poll, page visible, est aussi le SIGNAL DE SUIVI de
 * l'analyse — un résultat suivi à l'écran n'est pas notifié
 * (`document-notification-policy`).
 */
const POLL_INTERVAL_MS = ANALYSIS_FOLLOW_POLL_MS;

/** Fin d'analyse RÉUSSIE vue par ce poll (statut fonctionnel, sinon état brut) — pure. */
export function isSuccessfulCompletion(data: { processingStatus?: unknown; analysisState?: unknown } | null | undefined): boolean {
  if (!data) return false;
  if (typeof data.processingStatus === 'string') return data.processingStatus === 'COMPLETED';
  return typeof data.analysisState === 'string' && SUCCESS_STATES.includes(data.analysisState);
}
/** Au-delà de ce délai sans completion, forcer un poll même si pas de SSE */
const MAX_WAIT_MS = 5 * 60_000; // 5 min

interface AnalysisBannerContextType {
  analyzingCount: number;
  analyzingFileIds: number[];
  /** Timestamp (ms) auquel chaque fileId a commencé son analyse */
  analysisStartTimes: Record<number, number>;
  /**
   * Lot 108I : document dont l'analyse SUIVIE vient de réussir — le bandeau
   * affiche brièvement « Analyse terminée · Voir » (mise à jour de
   * l'interface à la place d'une notification).
   */
  recentlyCompletedFileId?: number | null;
}

const AnalysisBannerContext = createContext<AnalysisBannerContextType>({ analyzingCount: 0, analyzingFileIds: [], analysisStartTimes: {}, recentlyCompletedFileId: null });

export function useAnalysisBanner() {
  return useContext(AnalysisBannerContext);
}

export function AnalysisBannerProvider({ children }: { children: ReactNode }) {
  const [analyzingFileIds, setAnalyzingFileIds] = useState<number[]>([]);
  const [analysisStartTimes, setAnalysisStartTimes] = useState<Record<number, number>>({});
  const [recentlyCompletedFileId, setRecentlyCompletedFileId] = useState<number | null>(null);
  const cueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDoneCue = useCallback((fileId: number) => {
    setRecentlyCompletedFileId(fileId);
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = setTimeout(() => setRecentlyCompletedFileId(null), ANALYSIS_DONE_CUE_MS);
  }, []);
  useEffect(() => () => { if (cueTimerRef.current) clearTimeout(cueTimerRef.current); }, []);
  const analyzingFileIdsRef = useRef<number[]>([]);
  const analysisStartTimesRef = useRef<Record<number, number>>({});

  // Keep refs in sync for use in intervals/callbacks without stale closures
  useEffect(() => { analyzingFileIdsRef.current = analyzingFileIds; }, [analyzingFileIds]);
  useEffect(() => { analysisStartTimesRef.current = analysisStartTimes; }, [analysisStartTimes]);

  const removeFileId = useCallback((fileId: number) => {
    setAnalyzingFileIds(ids => {
      const idx = ids.indexOf(fileId);
      if (idx === -1) return ids;
      return [...ids.slice(0, idx), ...ids.slice(idx + 1)];
    });
    setAnalysisStartTimes(times => { const t = { ...times }; delete t[fileId]; return t; });
  }, []);

  const handleStart = useCallback((e: Event) => {
    const fileId = (e as CustomEvent)?.detail?.fileId;
    const now = Date.now();
    if (fileId) {
      setAnalyzingFileIds(ids => ids.includes(fileId) ? ids : [...ids, fileId]);
      setAnalysisStartTimes(times => ({ ...times, [fileId]: now }));
    } else {
      // Batch sans fileId — incrémenter juste le compteur via un id fictif
      const fakeId = -now;
      setAnalyzingFileIds(ids => [...ids, fakeId]);
      setAnalysisStartTimes(times => ({ ...times, [fakeId]: now }));
    }
  }, []);

  const handleComplete = useCallback((e: Event) => {
    const fileId = (e as CustomEvent)?.detail?.fileId;
    if (fileId) {
      removeFileId(fileId);
    } else {
      // Retirer le premier id fictif
      setAnalyzingFileIds(ids => {
        const idx = ids.findIndex(id => id < 0);
        if (idx === -1 && ids.length > 0) return ids.slice(1);
        if (idx !== -1) return [...ids.slice(0, idx), ...ids.slice(idx + 1)];
        return ids;
      });
      setAnalysisStartTimes(times => {
        const t = { ...times };
        const fakeId = Object.keys(t).map(Number).find(id => id < 0);
        if (fakeId !== undefined) delete t[fakeId];
        return t;
      });
    }
  }, [removeFileId]);

  useEffect(() => {
    window.addEventListener('document-analysis-start', handleStart);
    window.addEventListener('document-analysis-complete', handleComplete);
    return () => {
      window.removeEventListener('document-analysis-start', handleStart);
      window.removeEventListener('document-analysis-complete', handleComplete);
    };
  }, [handleStart, handleComplete]);

  // Au montage : LIRE l'état des analyses du compte (en attente, en cours) pour
  // réafficher le bandeau après un rechargement — CDC BO IA E-06.
  //
  // L'appel à `/api/analysis/check-pending` RELANÇAIT les analyses : la reprise
  // T1 dépendait de l'ouverture d'une session. Elle est désormais
  // exclusivement serveur (analysis-recovery : planificateur, passage planifié
  // T1, qui reprend aussi les documents d'un compte redevenu créditeur) ; ce
  // point d'entrée est en lecture seule, sur l'état persistant (file durable
  // T1). Le suivi de fin reste le polling ci-dessous.
  useEffect(() => {
    let annule = false;
    fetch('/api/analysis/queue-status', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { files?: Array<{ fileId?: unknown }> } | null) => {
        if (annule || !data || !Array.isArray(data.files)) return;
        const ids = data.files
          .map((f) => Number(f?.fileId))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (ids.length === 0) return;
        const now = Date.now();
        setAnalyzingFileIds((cur) => [...cur, ...ids.filter((id) => !cur.includes(id))]);
        setAnalysisStartTimes((times) => {
          const t = { ...times };
          for (const id of ids) if (t[id] === undefined) t[id] = now;
          return t;
        });
      })
      .catch(() => {});
    return () => { annule = true; };
  }, []);

  // Polling de sécurité : vérifie en DB l'état des docs encore en cours
  // pour détecter les analyses terminées dont le SSE n'a pas été reçu (coupure réseau, redémarrage serveur).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const checkStuckAnalyses = async () => {
      const ids = analyzingFileIdsRef.current.filter(id => id > 0);
      if (ids.length === 0) return;

      try {
        // Vérifier l'état de chaque doc en cours via l'API analysis-status
        await Promise.all(ids.map(async (fileId) => {
          try {
            // Lot 108I : page visible = analyse suivie à l'écran (signal de suivi).
            const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
            const res = await fetch(analysisStatusUrl(fileId, visible), {
      credentials: 'include',
            });
            if (!res.ok) return;
            const data = await res.json();
            const state: string | null = data?.analysisState ?? null;
            // Lot 34C : le statut FONCTIONNEL calculé par le serveur fait foi —
            // un échec intermédiaire suivi d'une reprise réelle n'est pas une
            // fin d'analyse. État brut seulement si le serveur ne le fournit pas.
            const termine = typeof data?.processingStatus === 'string'
              ? isSettledProcessingStatus(data.processingStatus)
              : Boolean(state && TERMINAL_STATES.includes(state));
            if (termine) {
              if (isSuccessfulCompletion(data)) showDoneCue(fileId);
              window.dispatchEvent(new CustomEvent('document-analysis-complete', { detail: { fileId } }));
            }
            // Si le doc est bloqué depuis trop longtemps (> MAX_WAIT_MS), forcer completion aussi
            const startTime = analysisStartTimesRef.current[fileId];
            if (startTime && Date.now() - startTime > MAX_WAIT_MS) {
              window.dispatchEvent(new CustomEvent('document-analysis-complete', { detail: { fileId } }));
            }
          } catch {
            // Silently ignore per-file errors
          }
        }));
      } catch {
        // Silently ignore global errors
      }
    };

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(checkStuckAnalyses, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    if (analyzingFileIds.length > 0) {
      startPolling();
    } else {
      stopPolling();
    }

    return stopPolling;
  }, [analyzingFileIds.length, showDoneCue]);

  const analyzingCount = analyzingFileIds.length;

  return (
    <AnalysisBannerContext.Provider value={{ analyzingCount, analyzingFileIds, analysisStartTimes, recentlyCompletedFileId }}>
      {children}
    </AnalysisBannerContext.Provider>
  );
}
