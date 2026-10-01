/**
 * Accès réseau de l'écran de préparation, derrière une interface : l'écran
 * reste testable et prévisualisable sans serveur (données simulées).
 *
 *   prepare   POST /api/assets/{id}/exports/prepare              (§17.1)
 *   estimate  POST /api/assets/{id}/exports/estimate             (§17.1)
 *   generate  POST /api/assets/{id}/exports  (payload `choices`)  (§17.2)
 *   poll      GET  /api/export-generations/{publicId}            (§15.3)
 *   viewUrl   GET  /api/files/{fileId}/view  (aperçu, « voir le document »)
 *   CIL       PATCH / DELETE /api/assets/{id}/exports/cil/resolutions,
 *             POST /api/assets/{id}/energy-materials
 */

import { apiClient } from '@/lib/api-client';
import { createExportSettleWatcher } from '@/lib/data-freshness';
import type { EstimateResponse, PreparationDto } from '@/services/exports/v12/preparation/types';

export interface GenerationPoll {
  publicId: string;
  generationStatus: string;
  outputFormat: string | null;
  currentStep?: string | null;
  downloadUrl: string | null;
  downloadZipUrl: string | null;
  excludedFiles?: Array<{ label: string; reason: string; reasonLabel: string }>;
  errorMessage: string | null;
  expiresAt: string | null;
}

export interface PreparationApi {
  prepare(body: Record<string, unknown>): Promise<PreparationDto>;
  estimate(body: Record<string, unknown>): Promise<EstimateResponse>;
  generate(body: Record<string, unknown>): Promise<{ generationPublicId: string; generationStatus: string }>;
  poll(publicId: string): Promise<GenerationPoll>;
  viewUrl(fileId: number): Promise<string | null>;
  setCilResolution(blockId: string, resolution: 'not_applicable' | null): Promise<void>;
  addEnergyMaterial(body: Record<string, unknown>): Promise<void>;
}

export interface ApiFailure { status: number; code: string; message: string; details?: Record<string, unknown> }

/** Erreur réseau → code et message affichables (jamais de détail technique). */
export function toFailure(err: unknown): ApiFailure {
  const e = err as { status?: number; code?: string; serverMessage?: string; message?: string; details?: Record<string, unknown> };
  return {
    details: e?.details,
    status: e?.status ?? 0,
    code: e?.code ?? 'NETWORK_ERROR',
    message: e?.serverMessage ?? (e?.status ? 'Une erreur est survenue. Réessayez.' : 'Connexion impossible. Vérifiez votre réseau et réessayez.'),
  };
}

export function httpPreparationApi(assetId: number): PreparationApi {
  // CDC 11 §15 : le passage à prêt / erreur n'est vu que par cette
  // interrogation GET (aucune écriture `apiClient`) — l'événement
  // `verebona:data-mutated` est émis ici pour que la mascotte recalcule
  // PROC-EXPORT sans attendre son minuteur.
  const generations = createExportSettleWatcher();
  return {
    prepare: (body) => apiClient.post<PreparationDto>(`/api/assets/${assetId}/exports/prepare`, body),
    estimate: (body) => apiClient.post<EstimateResponse>(`/api/assets/${assetId}/exports/estimate`, body),
    generate: (body) => apiClient.post(`/api/assets/${assetId}/exports`, body),
    poll: async (publicId) => {
      const g = await apiClient.get<GenerationPoll>(`/api/export-generations/${publicId}`);
      generations.observe(publicId, g.generationStatus);
      return g;
    },
    viewUrl: async (fileId) => {
      try {
        const r = await apiClient.get<{ viewUrl?: string; url?: string }>(`/api/files/${fileId}/view`, { useCache: true });
        return r.viewUrl ?? r.url ?? null;
      } catch {
        return null;
      }
    },
    setCilResolution: async (blockId, resolution) => {
      if (resolution) await apiClient.patch(`/api/assets/${assetId}/exports/cil/resolutions`, { blockId, resolution });
      else await apiClient.delete(`/api/assets/${assetId}/exports/cil/resolutions?blockId=${encodeURIComponent(blockId)}`);
    },
    addEnergyMaterial: async (body) => { await apiClient.post(`/api/assets/${assetId}/energy-materials`, body); },
  };
}
