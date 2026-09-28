/**
 * Aperçu d'un dossier V12 (back-office, MIG-06) : même moteur que la
 * génération (HTML/CSS + Chromium, annexes apposées), avec la pré-sélection
 * du CDC, SANS enregistrement ni dépôt sur le stockage.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { DossierCode } from '@/services/exports/catalog';
import { loadExportSource } from './data/source';
import { buildDefaultChoices } from './data/choices';
import { renderDossier } from './render/render-dossier';
import { parisDate, parisIso } from './generation/clock';

export interface DossierPreview {
  buffer: Buffer;
  contentType: 'application/pdf';
  renderer: 'v12-chromium';
  pageCount: number;
  templateVersion: string;
  /** Fichiers retenus mais exclus (manquants, illisibles). */
  partial: boolean;
}

export async function renderDossierPreviewPdf(params: { code: DossierCode; assetId: number; userId?: number }): Promise<DossierPreview> {
  const [asset] = await db.select({ accountId: assets.accountId, userId: assets.userId }).from(assets).where(eq(assets.id, params.assetId)).limit(1);
  if (!asset?.accountId) throw new Error(`Bien ${params.assetId} introuvable`);
  const today = parisDate();
  const source = await loadExportSource({ assetId: params.assetId, accountId: asset.accountId, userId: params.userId ?? asset.userId, exportType: params.code });
  const choices = buildDefaultChoices(params.code, source, { outputFormat: 'PDF', today });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verebona-export-preview-'));
  try {
    const r = await renderDossier({
      code: params.code, source, choices, today, workDir,
      meta: { reference: 'APERÇU', generatedAt: parisIso(), preparedBy: source.preparedBy },
    });
    return { buffer: r.pdf, contentType: 'application/pdf', renderer: 'v12-chromium', pageCount: r.pageCount, templateVersion: r.templateVersion, partial: r.partial };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
