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

export const PREVIEW_EXPORT_TYPES: readonly ExportType[] = [
  'CIL_REGLEMENTAIRE',
  'DOSSIER_VENTE',
  'DOSSIER_COMPLET',
  'ASSURANCE_ESTIMATION',
  'ASSURANCE_INDEMNISATION',
  'EXPORT_BRUT',
];

/** `export_templates.export_type` (libellés historiques) → type d'export du moteur. */
const LEGACY_EXPORT_TYPE_MAP: Record<string, ExportType> = {
  CIL: 'CIL_REGLEMENTAIRE',
  CIL_REGLEMENTAIRE: 'CIL_REGLEMENTAIRE',
  DOSSIER_VENTE: 'DOSSIER_VENTE',
  DOSSIER_COMPLET: 'DOSSIER_COMPLET',
  ASSURANCE_DEVIS: 'ASSURANCE_ESTIMATION',
  ASSURANCE_ESTIMATION: 'ASSURANCE_ESTIMATION',
  ASSURANCE_SINISTRE: 'ASSURANCE_INDEMNISATION',
  ASSURANCE_INDEMNISATION: 'ASSURANCE_INDEMNISATION',
  EXPORT_BRUT: 'EXPORT_BRUT',
};

export interface PreviewTemplateRef {
  code: string;
  exportType: string | null;
  category: string | null;
}

/**
 * Type d'export que le moteur produit pour ce modèle. Le moteur recherche le
 * modèle par `code` = type d'export ; à défaut on se rabat sur la colonne
 * `export_type`. `null` : modèle non utilisé par le moteur actuel.
 */
export function resolvePreviewExportType(template: PreviewTemplateRef): ExportType | null {
  const code = template.code?.trim().toUpperCase();
  if (code && (PREVIEW_EXPORT_TYPES as readonly string[]).includes(code)) return code as ExportType;
  const legacy = template.exportType?.trim().toUpperCase();
  if (legacy && LEGACY_EXPORT_TYPE_MAP[legacy]) return LEGACY_EXPORT_TYPE_MAP[legacy];
  return null;
}

/** Compatibilité d'un bien avec le modèle ; `null` si compatible, sinon motif. */
export function assetIneligibilityReason(
  exportType: ExportType,
  templateCategory: string | null,
  assetCategory: string,
): string | null {
  if (exportType === 'CIL_REGLEMENTAIRE' && assetCategory !== 'IMMOBILIER') {
    return 'Modèle réservé aux biens immobiliers.';
  }
  if (exportType === 'DOSSIER_VENTE' && !['IMMOBILIER', 'VEHICULE'].includes(assetCategory)) {
    return 'Modèle réservé aux biens immobiliers et aux véhicules.';
  }
  const cat = templateCategory?.trim().toUpperCase();
  if (cat && cat !== 'GENERAL' && cat !== assetCategory) {
    return 'Catégorie du bien différente de celle du modèle.';
  }
  return null;
}

/**
 * Données manquantes pour le rendu (EXP-011). Liste lisible, vide si rien ne
 * manque. Pure : testée sans base.
 */
export function listMissingPreviewData(
  manifest: Pick<ExportManifest, 'exportType' | 'sections' | 'includedDocuments' | 'unqualifiedDocCount' | 'missingRubricCount'>,
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
export function previewFileName(templateCode: string, exportType: ExportType, date = new Date()): string {
  const safe = templateCode.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_');
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `apercu_${safe}_${day}.${exportType === 'EXPORT_BRUT' ? 'zip' : 'pdf'}`;
}

export interface AdminPreviewAsset {
  id: number;
  name: string;
  category: string;
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
    ? await pgClient.unsafe<{ id: number; name: string; category: string; user_id: number }[]>(
        `SELECT id, name, category, user_id FROM assets
          WHERE account_id = $1 AND deleted_at IS NULL
          ORDER BY name ASC LIMIT 200`,
        [ownAccountId],
      )
    : await pgClient.unsafe<{ id: number; name: string; category: string; user_id: number }[]>(
        `SELECT id, name, category, user_id FROM assets
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY name ASC LIMIT 200`,
        [adminUserId],
      );
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category, ownerUserId: r.user_id }));
}

export interface PreviewTemplateRow extends PreviewTemplateRef {
  id: number;
  label: string;
  isActive: boolean;
  pdfmonkeyTemplateId: string | null;
}

export async function loadPreviewTemplate(templateId: number): Promise<PreviewTemplateRow | null> {
  const [row] = await pgClient.unsafe<
    { id: number; code: string; label: string; category: string; export_type: string | null; is_active: boolean; pdfmonkey_template_id: string | null }[]
  >(
    `SELECT id, code, label, category, export_type, is_active, pdfmonkey_template_id
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
    pdfmonkeyTemplateId: row.pdfmonkey_template_id,
  };
}

export interface PreviewAnalysis {
  exportType: ExportType;
  manifest: ExportManifest;
  snapshot: AssetSnapshot;
  missing: string[];
}

/** Snapshot + manifeste du bien choisi, avec les données manquantes. */
export async function analysePreview(exportType: ExportType, asset: AdminPreviewAsset): Promise<PreviewAnalysis> {
  const { buildAssetSnapshot } = await import('@/services/export-snapshot.service');
  const { buildExportManifest } = await import('@/services/export-manifest.service');
  const snapshot = await buildAssetSnapshot(asset.id, asset.ownerUserId);
  const manifest = buildExportManifest(exportType, snapshot, {
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
  const { renderExportPreviewPdf } = await import('@/services/pdf-renderer.service');
  const out = await renderExportPreviewPdf(analysis.manifest, analysis.snapshot, template.pdfmonkeyTemplateId);
  return { buffer: out.buffer, contentType: 'application/pdf', renderer: out.renderer, fallbackReason: out.fallbackReason };
}
