/**
 * Catalogue des dossiers d'un bien — CDC Exports V12 §1.2, §3.1 étape 1,
 * §17 / §26 (catalogue), EXP-001.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE L'UTILISATEUR PEUT PRÉPARER, ET POURQUOI PAS
 *
 * La liste des dossiers était une constante de l'interface (`EXPORT_USAGES`),
 * sans LOCATION, avec des familles fausses (vente d'objet proposée puis
 * refusée) et sans lien avec les droits. Le catalogue est désormais calculé
 * côté serveur, pour chaque dossier :
 *   - éligibilité par famille (§1.2) et, pour le CIL, par catégorie (maison,
 *     appartement) ;
 *   - droits de l'offre : dossier VERROUILLÉ (pas masqué) avec le motif prêt à
 *     afficher (Premium requis, essai terminé, impayé…) ;
 *   - indices de préparation : informations complémentaires recommandées non
 *     saisies, absence de documents ou de photos, blocs CIL bloquants ;
 *   - dernière génération (codes anciens compris).
 *
 * `buildExportCatalog` est pur (testé sans base) ; `loadExportCatalog`
 * rassemble les données.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, exportGenerations } from '@/db/schema';
import { isCilEligible } from '@/lib/asset-capabilities';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import {
  DOSSIER_ADDITIONAL_SECTIONS, DOSSIER_CODES, DOSSIER_DESCRIPTIONS, DOSSIER_FAMILIES, DOSSIER_LABELS,
  DOSSIER_SHORT_LABELS, familyIneligibilityMessage, isDossierEligibleForFamily, normalizeExportCode,
  toExportFamily, type AdditionalInfoSectionKey, type DossierCode, type ExportFamily,
} from './catalog';
import { getAssetAdditionalInfos, type AssetAdditionalInfos } from './additional-infos.service';

export type ReadinessSeverity = 'info' | 'warning' | 'blocking';
export type ReadinessStatus = 'ready' | 'incomplete' | 'blocked' | 'unavailable';

export interface ReadinessHint {
  code: string;
  severity: ReadinessSeverity;
  message: string;
  /** Où compléter : sous-rubrique d'informations complémentaires, documents, photos, préparation CIL. */
  target?: `additional-infos:${AdditionalInfoSectionKey}` | 'documents' | 'photos' | 'cil-preparation';
}

export interface CatalogLastGeneration {
  id: number;
  publicId: string;
  exportType: DossierCode | 'EXPORT_BRUT';
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CatalogDossier {
  code: DossierCode;
  label: string;
  shortLabel: string;
  description: string;
  families: readonly ExportFamily[];
  eligible: boolean;
  /** Motif d'inéligibilité, prêt à afficher ; `null` si éligible. */
  eligibilityReason: string | null;
  /** Dossier éligible mais non ouvert par l'offre / l'état du compte. */
  locked: boolean;
  lockReason: { code: string; message: string } | null;
  readiness: { status: ReadinessStatus; hints: ReadinessHint[] };
  /** Sous-rubriques d'informations complémentaires lues par ce dossier. */
  additionalSections: readonly AdditionalInfoSectionKey[];
  lastGeneration: CatalogLastGeneration | null;
}

export interface ExportCatalog {
  assetId: number;
  family: ExportFamily | null;
  dossiers: CatalogDossier[];
  lastGenerations: CatalogLastGeneration[];
  eligibility: Array<{ code: DossierCode; eligible: boolean; reason: string | null }>;
}

export interface CatalogInput {
  asset: { id: number; category: string; subtype: string | null };
  premium: { allowed: boolean; reason?: string; message?: string };
  counts: { documents: number; photos: number };
  additional: Pick<AssetAdditionalInfos, 'commercial' | 'rental' | 'insurance' | 'claim'>;
  /** Préparation CIL, si le bien y est éligible. */
  cil: { globalStatus: 'ready' | 'action_required'; percentage: number; blockingLabels: string[] } | null;
  /** Dossiers désactivés depuis le back-office : non proposés. */
  unavailable?: ReadonlySet<DossierCode>;
  /** Générations du bien, les plus récentes d'abord. */
  generations: Array<{ id: number; publicId: string; exportType: string; status: string; createdAt: Date | string; completedAt: Date | string | null }>;
}

const iso = (d: Date | string | null): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));

const has = (section: Record<string, unknown>, key: string) => section[key] !== undefined && section[key] !== null && section[key] !== '';

function readinessHints(code: DossierCode, input: CatalogInput): ReadinessHint[] {
  const hints: ReadinessHint[] = [];
  const { documents, photos } = input.counts;
  const a = input.additional;

  switch (code) {
    case 'CIL':
      if (input.cil?.globalStatus === 'action_required') {
        hints.push({
          code: 'CIL_ACTION_REQUIRED', severity: 'blocking', target: 'cil-preparation',
          message: `Blocs à compléter avant génération : ${input.cil.blockingLabels.join(', ') || 'voir la préparation'}.`,
        });
      }
      break;
    case 'VENTE':
      if (!has(a.commercial, 'desiredSalePriceCents')) {
        hints.push({ code: 'SALE_PRICE_MISSING', severity: 'warning', target: 'additional-infos:commercial', message: 'Prix de vente souhaité non renseigné : il ne figurera pas dans le kit.' });
      }
      break;
    case 'LOCATION':
      if (!has(a.rental, 'monthlyRentCents')) {
        hints.push({ code: 'RENT_MISSING', severity: 'warning', target: 'additional-infos:rental', message: 'Loyer mensuel non renseigné : il ne figurera pas dans le dossier.' });
      }
      break;
    case 'ASSURANCE_SOUSCRIPTION':
      if (!has(a.insurance, 'insuranceObjective')) {
        hints.push({ code: 'INSURANCE_OBJECTIVE_MISSING', severity: 'warning', target: 'additional-infos:insurance', message: "Objectif de la demande non renseigné (recommandé pour l'assureur)." });
      }
      break;
    case 'ASSURANCE_SINISTRE':
      if (!has(a.claim, 'claimType') || !has(a.claim, 'occurredOn')) {
        hints.push({ code: 'CLAIM_MISSING', severity: 'warning', target: 'additional-infos:claim', message: 'Type et date du sinistre à renseigner pour une synthèse complète.' });
      }
      break;
    default:
      break;
  }

  if (documents === 0 && code !== 'VENTE' && code !== 'LOCATION') {
    hints.push({ code: 'NO_DOCUMENTS', severity: 'info', target: 'documents', message: 'Aucun document rattaché au bien.' });
  }
  if (photos === 0 && (code === 'VENTE' || code === 'LOCATION' || code === 'ASSURANCE_SINISTRE')) {
    hints.push({
      code: 'NO_PHOTOS', severity: 'info', target: 'photos',
      message: code === 'ASSURANCE_SINISTRE' ? 'Aucune photo : ajoutez celles des dommages si vous en avez.' : 'Aucune photo : la couverture sera graphique.',
    });
  }
  return hints;
}

/** Catalogue complet d'un bien — pur. */
export function buildExportCatalog(input: CatalogInput): ExportCatalog {
  const family = toExportFamily(input.asset.category);

  // Dernière génération par dossier (codes anciens ramenés aux codes V12).
  const lastByCode = new Map<string, CatalogLastGeneration>();
  const lastGenerations: CatalogLastGeneration[] = [];
  for (const g of input.generations) {
    const code = normalizeExportCode(g.exportType);
    if (!code || lastByCode.has(code)) continue;
    const entry: CatalogLastGeneration = {
      id: g.id, publicId: g.publicId, exportType: code, status: g.status,
      createdAt: iso(g.createdAt) ?? '', completedAt: iso(g.completedAt),
    };
    lastByCode.set(code, entry);
    lastGenerations.push(entry);
  }

  const dossiers = DOSSIER_CODES.filter((code) => !input.unavailable?.has(code)).map((code): CatalogDossier => {
    let eligible = isDossierEligibleForFamily(code, input.asset.category);
    if (eligible && code === 'CIL' && !isCilEligible({ category: input.asset.category, subtype: input.asset.subtype })) {
      eligible = false;
    }
    const eligibilityReason = eligible ? null : familyIneligibilityMessage(code);
    const locked = eligible && !input.premium.allowed;
    const hints = eligible ? readinessHints(code, input) : [];
    const status: ReadinessStatus = !eligible
      ? 'unavailable'
      : hints.some((h) => h.severity === 'blocking')
        ? 'blocked'
        : hints.some((h) => h.severity === 'warning')
          ? 'incomplete'
          : 'ready';
    return {
      code,
      label: DOSSIER_LABELS[code],
      shortLabel: DOSSIER_SHORT_LABELS[code],
      description: DOSSIER_DESCRIPTIONS[code],
      families: DOSSIER_FAMILIES[code],
      eligible,
      eligibilityReason,
      locked,
      lockReason: locked
        ? {
            code: input.premium.reason ?? 'PREMIUM_REQUIRED',
            message: input.premium.message ?? 'Les dossiers prêts à l’emploi sont disponibles avec Premium et Premium Duo.',
          }
        : null,
      readiness: { status, hints },
      additionalSections: DOSSIER_ADDITIONAL_SECTIONS[code],
      lastGeneration: lastByCode.get(code) ?? null,
    };
  });

  return {
    assetId: input.asset.id,
    family,
    dossiers,
    lastGenerations,
    eligibility: dossiers.map((d) => ({ code: d.code, eligible: d.eligible, reason: d.eligibilityReason })),
  };
}

/** Rassemble les données du catalogue d'un bien du compte (accès déjà vérifié). */
export async function loadExportCatalog(asset: {
  id: number; accountId: number; category: string; subtype: string | null;
  address: string | null; postalCode: string | null; city: string | null;
}): Promise<ExportCatalog> {
  const { loadInactiveDossiers } = await import('./dossier-availability');
  const [premium, fileCounts, additional, generations, unavailable] = await Promise.all([
    canUsePremiumFeature(asset.accountId),
    db
      .select({
        photos: count(sql`CASE WHEN ${assetFiles.mimeType} LIKE 'image/%' AND ${assetFiles.isWebLink} = false THEN 1 END`),
        documents: count(sql`CASE WHEN ${assetFiles.mimeType} IS NULL OR ${assetFiles.mimeType} NOT LIKE 'image/%' THEN 1 END`),
      })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.assetId, asset.id),
        eq(assetFiles.accountId, asset.accountId),
        eq(assetFiles.uploadStatus, 'COMPLETED'),
        isNull(assetFiles.deletedAt),
      )),
    getAssetAdditionalInfos(asset.id, asset.accountId),
    db
      .select({
        id: exportGenerations.id,
        publicId: exportGenerations.publicId,
        exportType: exportGenerations.exportType,
        status: exportGenerations.status,
        createdAt: exportGenerations.createdAt,
        completedAt: exportGenerations.completedAt,
      })
      .from(exportGenerations)
      .where(and(eq(exportGenerations.assetId, asset.id), eq(exportGenerations.accountId, asset.accountId)))
      .orderBy(desc(exportGenerations.createdAt))
      .limit(50),
    loadInactiveDossiers(),
  ]);

  let cil: CatalogInput['cil'] = null;
  if (isCilEligible({ category: asset.category, subtype: asset.subtype })) {
    try {
      const { evaluateCilReadiness } = await import('./cil-preparation.service');
      const r = await evaluateCilReadiness(asset);
      cil = { globalStatus: r.globalStatus, percentage: r.completion.percentage, blockingLabels: r.blockingBlocks.map((b) => b.label) };
    } catch (err) {
      // Indice informatif : son échec ne doit pas priver l'utilisateur du catalogue.
      console.error('[export-catalog] préparation CIL indisponible :', (err as Error).message);
    }
  }

  return buildExportCatalog({
    asset: { id: asset.id, category: asset.category, subtype: asset.subtype },
    premium: { allowed: premium.allowed, reason: premium.reason, message: premium.message },
    counts: { documents: Number(fileCounts[0]?.documents ?? 0), photos: Number(fileCounts[0]?.photos ?? 0) },
    additional,
    cil,
    generations,
    unavailable,
  });
}
