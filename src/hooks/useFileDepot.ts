"use client";

import { useSyncExternalStore } from 'react';
import { fileDepot, type InstantaneDepot } from '@/lib/upload-queue';

const VIDE: InstantaneDepot = { elements: [], enCours: 0 };

/** État de la file de dépôt globale (APP-PERF-29), indépendant des panneaux. */
export function useFileDepot(): InstantaneDepot {
  return useSyncExternalStore(fileDepot.subscribe, fileDepot.getSnapshot, () => VIDE);
}
