"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

const TERMINAL_STATES = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'ANALYSIS_FAILED'];
/** Délai entre deux polls de vérification (quand une analyse est en cours) */
const POLL_INTERVAL_MS = 4_000;
/** Au-delà de ce délai sans completion, forcer un poll même si pas de SSE */
const MAX_WAIT_MS = 5 * 60_000; // 5 min

interface AnalysisBannerContextType {
  analyzingCount: number;
  analyzingFileIds: number[];
  /** Timestamp (ms) auquel chaque fileId a commencé son analyse */
  analysisStartTimes: Record<number, number>;
}

const AnalysisBannerContext = createContext<AnalysisBannerContextType>({ analyzingCount: 0, analyzingFileIds: [], analysisStartTimes: {} });

export function useAnalysisBanner() {
  return useContext(AnalysisBannerContext);
}

export function AnalysisBannerProvider({ children }: { children: ReactNode }) {
  const [analyzingFileIds, setAnalyzingFileIds] = useState<number[]>([]);
  const [analysisStartTimes, setAnalysisStartTimes] = useState<Record<number, number>>({});
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

  // Au montage : vérifier si des documents non analysés existent et déclencher leur analyse.
  // Couvre le cas où l'utilisateur avait épuisé son quota puis a rechargé du crédit / upgradé.
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
    if (!token) return;
    fetch('/api/analysis/check-pending', {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, []);

  // Polling de sécurité : vérifie en DB l'état des docs encore en cours
  // pour détecter les analyses terminées dont le SSE n'a pas été reçu (coupure réseau, redémarrage serveur).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const checkStuckAnalyses = async () => {
      const ids = analyzingFileIdsRef.current.filter(id => id > 0);
      if (ids.length === 0) return;

      const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
      if (!token) return;

      try {
        // Vérifier l'état de chaque doc en cours via l'API analysis-status
        await Promise.all(ids.map(async (fileId) => {
          try {
            const res = await fetch(`/api/documents/${fileId}/analysis-status`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const data = await res.json();
            const state: string | null = data?.analysisState ?? null;
            // Si l'état est terminal, signaler la completion
            if (state && TERMINAL_STATES.includes(state)) {
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
  }, [analyzingFileIds.length]);

  const analyzingCount = analyzingFileIds.length;

  return (
    <AnalysisBannerContext.Provider value={{ analyzingCount, analyzingFileIds, analysisStartTimes }}>
      {children}
    </AnalysisBannerContext.Provider>
  );
}
