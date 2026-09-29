/**
 * Suivi d'une génération pour l'écran de préparation — CDC V12 §5.2
 * (PREP-PROGRESS, PREP-RESULT), §15.3, ALT-004, MSG-PREP-007.
 *
 *   · `currentStep` : dernière étape journalisée du job (identifiant seul,
 *     LOG-001) — l'écran l'affiche en cinq temps : préparation, rendu PDF,
 *     assemblage ZIP, stockage, finalisation ;
 *   · `excludedFiles` : fichiers exclus d'une génération PARTIELLE (absents,
 *     illisibles, protégés, trop lourds) — libellé et motif, jamais le
 *     détail technique. DRH-008 : rien n'est exposé hors statut partiel.
 */

import { db } from '@/db';
import { exportGenerationItems, exportGenerationLogs } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { GenerationStatus } from './status';

/** Motifs d'exclusion « fichier » d'une génération partielle. */
export const FILE_EXCLUSION_REASONS = ['missing', 'corrupted', 'protected', 'unreadable', 'too_large'] as const;

export const EXCLUSION_LABELS: Record<(typeof FILE_EXCLUSION_REASONS)[number], string> = {
  missing: 'Fichier introuvable',
  corrupted: 'Fichier illisible',
  protected: 'Fichier protégé par un mot de passe',
  unreadable: 'Format non lisible',
  too_large: 'Fichier trop volumineux',
};

export interface GenerationProgress {
  currentStep: string | null;
  excludedFiles: Array<{ label: string; reason: string; reasonLabel: string }>;
}

export async function loadGenerationProgress(generationId: number, status: GenerationStatus): Promise<GenerationProgress> {
  const out: GenerationProgress = { currentStep: null, excludedFiles: [] };
  if (status === 'queued' || status === 'generating') {
    const [last] = await db.select({ step: exportGenerationLogs.step }).from(exportGenerationLogs)
      .where(eq(exportGenerationLogs.generationId, generationId))
      .orderBy(desc(exportGenerationLogs.createdAt), desc(exportGenerationLogs.id)).limit(1);
    out.currentStep = last?.step ?? null;
  }
  if (status === 'partial') {
    const rows = await db.select({ label: exportGenerationItems.label, reason: exportGenerationItems.reason }).from(exportGenerationItems)
      .where(and(
        eq(exportGenerationItems.generationId, generationId),
        eq(exportGenerationItems.status, 'excluded'),
        inArray(exportGenerationItems.reason, [...FILE_EXCLUSION_REASONS]),
      ))
      .limit(200);
    out.excludedFiles = rows.map((r) => ({
      label: r.label ?? 'Fichier',
      reason: r.reason ?? 'missing',
      reasonLabel: EXCLUSION_LABELS[(r.reason ?? 'missing') as keyof typeof EXCLUSION_LABELS] ?? 'Fichier exclu',
    }));
  }
  return out;
}
