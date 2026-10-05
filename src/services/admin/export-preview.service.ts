/**
 * Prévisualisation des modèles d'export — CDC Back-Office V1 §11.2
 * (EXP-008 à EXP-012, SEC-005, REC-MOD-05).
 *
 * - EXP-009 / SEC-005 : seules les données du PROPRE compte de
 *   l'administrateur connecté sont utilisables. Les biens proposés sont ceux
 *   de ce compte ; un bien d'un autre compte est refusé côté serveur.
 * - EXP-010 : les modèles actuels portent tous sur un bien ; l'administrateur
 *   choisit le bien parmi ceux compatibles avec le modèle.
 * - EXP-011 : les données manquantes sont listées ; le rendu reste produit
 *   (prévisualisation partielle) — jamais de donnée empruntée.
 * - EXP-012 : le fichier rendu est renvoyé tel quel pour téléchargement.
 *
 * Aucune génération n'est enregistrée (`export_generation`) et rien n'est
 * déposé sur le stockage : la prévisualisation n'est pas un export.
 */
import { pgClient } from '@/db';
import type { ExportManifest, ExportType } from '@/services/export-manifest.service';
import type { AssetSnapshot } from '@/services/export-snapshot.service';
import {
  DOSSIER_CODES, EXPORT_BRUT_CODE, familyIneligibilityMessage, isDossierEligibleForFamily, normalizeExportCode,
  type ExportCode,
} from '@/services/exports/catalog';
import { isCilEligible } from '@/lib/asset-capabilities';

/** Codes prévisualisables : les six dossiers V12 et l'export brut (catalogue). */
export const PREVIEW_EXPORT_TYPES: readonly ExportCode[] = [...DOSSIER_CODES, EXPORT_BRUT_CODE];

export interface PreviewTemplateRef {
  code: string;
  exportType: string | null;
  category: string | null;
}

/**
 * Code du dossier que le moteur produit pour ce modèle : le `code` du modèle
 * s'il désigne un dossier (ancien code compris), sinon la colonne
 * `export_type` (renommée en V12 par la migration 0213, anciens libellés
 * encore reconnus). `null` : modèle non utilisé par le moteur (SAV_GARANTIE…).
 */
export function resolvePreviewExportType(template: PreviewTemplateRef): ExportCode | null {
  return normalizeExportCode(template.code) ?? normalizeExportCode(template.exportType);
}

/** Compatibilité d'un bien avec le modèle ; `null` si compatible, sinon motif. */
export function assetIneligibilityReason(
  exportType: ExportCode,
  templateCategory: string | null,
  assetCategory: string,
  assetSubtype?: string | null,
): string | null {
  if (exportType !== EXPORT_BRUT_CODE) {
    // Familles du catalogue V12 (§1.2) : même règle que l'application.
    if (!isDossierEligibleForFamily(exportType, assetCategory)) return familyIneligibilityMessage(exportType);
    if (exportType === 'CIL' && assetSubtype !== undefined && !isCilEligible({ category: assetCategory, subtype: assetSubtype })) {
      return familyIneligibilityMessage('CIL');
    }
  }
  const cat = templateCategory?.trim().toUpperCase();
  if (cat && cat !== 'GENERAL' && cat !== assetCategory) {
    return 'Catégorie du bien différente de celle du modèle.';
  }
  return null;
}

/**
 * Le moteur de rendu reçoit le code V12 : c'est le contrat du moteur V12
 * (codes du catalogue). Conversion de type seulement, aucune traduction.
 */
const toEngineType = (code: ExportCode): ExportType => code as unknown as ExportType;

/**
 * Données manquantes pour le rendu (EXP-011). Liste lisible, vide si rien ne
 * manque. Pure : testée sans base.
 */
export function listMissingPreviewData(
  manifest: Pick<ExportManifest, 'sections' | 'includedDocuments' | 'unqualifiedDocCount' | 'missingRubricCount'> & { exportType: string },
  snapshot: Pick<AssetSnapshot, 'category' | 'address' | 'city' | 'postalCode' | 'purchaseDate' | 'purchasePriceCents' | 'estimatedValueCents' | 'photos' | 'events' | 'documents'>,
): string[] {
  const missing: string[] = [];
  const wants = (key: string) => manifest.sections.some((s) => s.key === key && s.include);
  const realDocs = snapshot.documents.filter((d) => !d.isWebLink);

  if (snapshot.category === 'IMMOBILIER' && (!snapshot.address || !snapshot.city || !snapshot.postalCode)) {
    missing.push('Adresse complète du bien (adresse, code postal, ville).');
  }
  if (!snapshot.purchaseDate) missing.push('Date d’acquisition du bien.');
  if (snapshot.purchasePriceCents == null && snapshot.estimatedValueCents == null) {
    missing.push('Prix d’achat ou valeur estimée du bien.');
  }
  if (manifest.exportType !== 'EXPORT_BRUT') {
    if (realDocs.length === 0) missing.push('Aucun document rattaché au bien.');
    else if (manifest.includedDocuments.length === 0) {
      missing.push('Aucun document du bien ne correspond aux pièces attendues par ce modèle.');
    }
  } else if (snapshot.documents.length === 0) {
    missing.push('Aucun document rattaché au bien.');
  }
  if (manifest.unqualifiedDocCount > 0) {
    missing.push(`${manifest.unqualifiedDocCount} document(s) non qualifié(s) exclu(s) du rendu.`);
  }
  if ((manifest.missingRubricCount ?? 0) > 0) {
    missing.push(`${manifest.missingRubricCount} rubrique(s) réglementaire(s) sans justificatif.`);
  }
  if (wants('maintenance') && snapshot.events.length === 0) missing.push('Aucun historique d’entretien.');
  if (manifest.exportType !== 'EXPORT_BRUT' && snapshot.photos.length === 0) missing.push('Aucune photo du bien.');
  return missing;
}

/** Nom de fichier de la prévisualisation (EXP-012). */
export function previewFileName(templateCode: string, exportType: ExportCode, date = new Date()): string {
  const safe = templateCode.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_');
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `apercu_${safe}_${day}.${exportType === 'EXPORT_BRUT' ? 'zip' : 'pdf'}`;
}

export interface AdminPreviewAsset {
  id: number;
  name: string;
  category: string;
  subtype: string | null;
  ownerUserId: number;
}

/**
 * Biens du propre compte de l'administrateur (EXP-009). Le compte retenu est
 * le compte courant de la session s'il en est membre ; à défaut, ses propres
 * biens. Jamais les biens d'un autre compte.
 */
export async function listAdminOwnAssets(adminUserId: number, accountId?: number | null): Promise<AdminPreviewAsset[]> {
  const { resolveAdminOwnAccountId } = await import('./admin-own-account');
  const ownAccountId = await resolveAdminOwnAccountId(adminUserId, accountId);
  const rows = ownAccountId
    ? await pgClient.unsafe<{ id: number; name: string; category: string; subtype: string | null; user_id: number }[]>(
        `SELECT id, name, category, subtype, user_id FROM assets
          WHERE account_id = $1 AND deleted_at IS NULL
          ORDER BY name ASC LIMIT 200`,
        [ownAccountId],
      )
    : await pgClient.unsafe<{ id: number; name: string; category: string; subtype: string | null; user_id: number }[]>(
        `SELECT id, name, category, subtype, user_id FROM assets
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY name ASC LIMIT 200`,
        [adminUserId],
      );
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category, subtype: r.subtype ?? null, ownerUserId: r.user_id }));
}

/**
 * MIG-06 / DEC-001 : `pdfmonkey_template_id` n'est plus lu. La colonne reste
 * en base (historique), mais ni la prévisualisation ni le back-office ne s'en
 * servent : le rendu est celui du moteur de l'application.
 */
export interface PreviewTemplateRow extends PreviewTemplateRef {
  id: number;
  label: string;
  isActive: boolean;
}

export async function loadPreviewTemplate(templateId: number): Promise<PreviewTemplateRow | null> {
  const [row] = await pgClient.unsafe<
    { id: number; code: string; label: string; category: string; export_type: string | null; is_active: boolean }[]
  >(
    `SELECT id, code, label, category, export_type, is_active
       FROM export_templates WHERE id = $1`,
    [templateId],
  );
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    category: row.category,
    exportType: row.export_type,
    isActive: row.is_active,
  };
}

export interface PreviewAnalysis {
  exportType: ExportCode;
  manifest: ExportManifest;
  snapshot: AssetSnapshot;
  missing: string[];
}

/** Snapshot + manifeste du bien choisi, avec les données manquantes. */
export async function analysePreview(exportType: ExportCode, asset: AdminPreviewAsset): Promise<PreviewAnalysis> {
  // X-02 (lot 16) : même source (canonique) que les exports.
  const { buildExportAssetSnapshot } = await import('@/services/exports/export-snapshot-source');
  const { buildExportManifest } = await import('@/services/export-manifest.service');
  const snapshot = await buildExportAssetSnapshot(asset.id, asset.ownerUserId, undefined, 'ADMIN_PREVIEW');
  const manifest = buildExportManifest(toEngineType(exportType), snapshot, {
    requestedOutputs: exportType === 'EXPORT_BRUT' ? ['ZIP'] : ['PDF'],
  });
  return { exportType, manifest, snapshot, missing: listMissingPreviewData(manifest, snapshot) };
}

/** Rendu final (PDF, ou ZIP pour l'export brut) — EXP-008, EXP-012. */
export async function renderPreviewFile(
  template: PreviewTemplateRow,
  analysis: PreviewAnalysis,
  isPremiumAccount: boolean,
): Promise<{ buffer: Buffer; contentType: string; renderer: string; fallbackReason: string | null }> {
  if (analysis.exportType === 'EXPORT_BRUT') {
    const { buildExportZip } = await import('@/services/export-zip.service');
    const buffer = await buildExportZip(analysis.manifest, analysis.snapshot, null, isPremiumAccount);
    return { buffer, contentType: 'application/zip', renderer: 'zip', fallbackReason: null };
  }
  // Plus d'identifiant PDFMonkey transmis (MIG-06) : moteur de l'application
  // uniquement ; `template` ne sert plus qu'au contrôle d'activation amont.
  void template;
  // Moteur V12 (HTML/CSS + Chromium, DEC-003) : plus de jsPDF ni de PDFMonkey.
  const { renderDossierPreviewPdf } = await import('@/services/exports/v12/preview');
  const out = await renderDossierPreviewPdf({ code: analysis.exportType, assetId: analysis.snapshot.id });
  return {
    buffer: out.buffer,
    contentType: out.contentType,
    renderer: out.renderer,
    fallbackReason: out.partial ? 'Certains fichiers du bien n’ont pas pu être intégrés à l’aperçu.' : null,
  };
}
