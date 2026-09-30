/**
 * Données sources d'un dossier V12, lues en base au moment de la génération
 * (étape `lock_snapshot` du §15.3).
 *
 * Tout est lu une fois, puis figé dans le snapshot de la génération
 * (IC-GEN-010, §16.3) : les mappeurs (`data/mappers/*`) sont des fonctions
 * PURES de cette structure, testées sans base.
 *
 * Portée : le bien est lu par compte (`accountId`, Duo compris — DRH-001/002).
 * Ne sont jamais lus : estimation Verebona, fourchettes de valorisation,
 * données d'occupation (statut, notes, loyer historique) — ce qui garantit
 * qu'aucun template ne peut les imprimer.
 */

import { db } from '@/db';
import {
  assets, users, agendaItems, agendaAssetLinks, assetCilProfiles, energyMaterials, energyWorks,
  equipments, equipmentCilSpecs, cilBlockResolutions,
} from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { buildAssetSnapshot, type AssetSnapshot, type DocumentRef, type PhotoRef } from '@/services/export-snapshot.service';
import { getAssetAdditionalInfos } from '@/services/exports/additional-infos.service';
import type { AdditionalInfoValue } from '@/lib/assets/additional-infos';
import { evaluateCilReadiness, type CilReadiness } from '@/services/exports/cil-preparation.service';
import { toExportFamily, type ExportFamily, type DossierCode } from '@/services/exports/catalog';
import {
  classifyDocument, documentTitle, documentTypeLabel, fileFormatOf, isIntegrable, type DocKind,
} from './documents';
import type { AgendaStatus4 } from '@/services/verebona-assistant/canonical/agenda';
import type { ExportSourceTrace } from './canonical-source';

/**
 * Valeurs des informations complémentaires (contrat `getAssetAdditionalInfos`) :
 * champs simples et, depuis le schéma v2, listes structurées (`ListItem[]`).
 */
export type InfoSection = Record<string, AdditionalInfoValue | null | undefined>;

export interface AdditionalInfosSnapshot {
  commercial: InfoSection;
  rental: InfoSection;
  insurance: InfoSection;
  claim: InfoSection;
  /** Absente des snapshots antérieurs à la migration 0214. */
  finance?: InfoSection;
  updatedAt: string | null;
}

export interface SourceDocument {
  id: number;
  title: string;
  typeLabel: string;
  kind: DocKind;
  format: string;
  integrable: boolean;
  sensitive: boolean;
  occupantData: boolean;
  date: string | null;
  sizeBytes: number | null;
  fileName: string | null;
  mimeType: string | null;
  s3Key: string | null;
  s3Bucket: string | null;
  supplier: string | null;
  amountCents: number | null;
  description: string | null;
  cilRubricCodes: string[];
  /** Tous les codes connus (types V1/V2, fonction retenue, rubriques CIL), en capitales. */
  codes: string[];
  equipmentId: number | null;
  /**
   * Source canonique (relecture lot 16) : rattachement non confirmé
   * (lien SECONDARY AI, `linked_asset_id` / `linked_room_id`) — proposé
   * DÉCOCHÉ, jamais pré-sélectionné. Absent en lecture historique.
   */
  unconfirmedLink?: boolean;
}

export interface SourcePhoto {
  id: number;
  fileId: number | null;
  s3Key: string | null;
  s3Bucket: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  displayOrder: number;
  isPrimary: boolean;
  caption: string | null;
  date: string | null;
}

export interface SourceEvent {
  /** `event:12` (table historique) ou `agenda:34` (agenda). */
  key: string;
  source: 'event' | 'agenda';
  id: number;
  title: string;
  date: string | null;
  /** Catégorie historique (`entretien`, `reparation`, `sinistre`…) ; null pour l'agenda. */
  category: string | null;
  /** `realise` | `prevu` | `annule` … */
  status: string | null;
  provider: string | null;
  costCents: number | null;
  description: string | null;
  /** Prévision issue d'une récurrence (agenda). */
  forecast: boolean;
  /**
   * Source canonique seulement (X-02, lot 16) : nature D-14 et statut à
   * 4 états du lot 14. Absents en lecture historique (règles inchangées).
   */
  nature?: 'HISTORICAL' | 'DEADLINE' | null;
  status4?: AgendaStatus4;
}

export interface SourceEquipment {
  id: number;
  name: string;
  type: string | null;
  category: string | null;
  brand: string | null;
  model: string | null;
  energyType: string | null;
}

export interface SourceCil {
  readiness: CilReadiness;
  profile: { triggerType: string | null; triggerDate: string | null; authorizationType: string | null; voluntaryReason: string | null } | null;
  materials: Array<{ id: number; category: string; materialNature: string | null; brand: string | null; reference: string | null; thermalResistanceR: string | null; lambda: string | null; thicknessMm: number | null; documentId: number | null }>;
  works: Array<{ id: number; category: string; title: string; description: string | null; completedAt: string | null; companyName: string | null }>;
  resolutions: Array<{ blockId: string; resolution: string; justification: string | null }>;
}

export interface ExportSource {
  exportType: DossierCode;
  family: ExportFamily;
  asset: {
    id: number;
    publicId: string;
    name: string;
    category: string;
    subtype: string | null;
    objectCategory: string | null;
    status: string;
    generalCondition: string | null;
    purchaseDate: string | null;
    purchasePriceCents: number | null;
    warrantyEndDate: string | null;
    mileageOrHours: number | null;
    registrationNumber: string | null;
    dimensions: string | null;
    engineInfo: string | null;
    purchaseLocation: string | null;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    description: string | null;
    /** Caractéristiques (`key_characteristics`) SANS les clés d'estimation ni d'occupation. */
    characteristics: Record<string, unknown>;
    equipmentList: string[];
  };
  documents: SourceDocument[];
  photos: SourcePhoto[];
  events: SourceEvent[];
  equipments: SourceEquipment[];
  rooms: Array<{ id: number; name: string }>;
  additionalInfo: AdditionalInfosSnapshot;
  cil: SourceCil | null;
  preparedBy: string | null;
  /** Source réellement utilisée et version du registre (X-02, figé dans le snapshot). */
  sourceTrace?: ExportSourceTrace;
}

/**
 * Clés de `key_characteristics` jamais transmises aux mappeurs : estimation
 * Verebona (VENTE-RULE-001, LOCATION-RULE-001) et données d'occupation
 * (garde-fou « occupant »).
 */
export const FORBIDDEN_CHARACTERISTICS = new Set([
  'estimatedValue', 'estimatedValueDate', 'estimatedValueMode', 'valuationLow', 'valuationHigh', 'valuationSource', 'valuationDate',
  'occupancyStatus', 'occupancyNotes', 'monthlyRent', 'charges', 'tenantName', 'tenant', 'occupant', 'occupantName',
  'insuranceClientNumber', 'insurancePremium',
]);

export function cleanCharacteristics(kc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(kc ?? {}).filter(([k]) => !FORBIDDEN_CHARACTERISTICS.has(k)));
}

const asIso = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Pièces : exclut les photos de la galerie (traitées à part) et les liens web. */
export function toSourceDocuments(docs: DocumentRef[], photoFileIds: Set<number>): SourceDocument[] {
  return docs
    .filter((d) => !d.isWebLink && !photoFileIds.has(d.id))
    .map((d) => {
      const cls = classifyDocument(d);
      const format = fileFormatOf(d.mimeType, d.originalFilename);
      return {
        id: d.id,
        title: documentTitle(d),
        typeLabel: documentTypeLabel(d),
        kind: cls.kind,
        format,
        integrable: isIntegrable(format),
        sensitive: cls.sensitive,
        occupantData: cls.occupantData,
        date: asIso(d.documentDate),
        sizeBytes: d.size ?? null,
        fileName: d.originalFilename ?? null,
        mimeType: d.mimeType ?? null,
        s3Key: d.s3Key ?? null,
        s3Bucket: d.s3Bucket ?? null,
        supplier: d.supplier ?? null,
        amountCents: d.amountCents ?? null,
        description: d.description ?? null,
        cilRubricCodes: Array.isArray(d.cilRubricCodes) ? d.cilRubricCodes : [],
        codes: [d.documentType, d.retainedFunctionCode, d.documentTypeCode, ...(Array.isArray(d.cilRubricCodes) ? d.cilRubricCodes : [])]
          .filter((c): c is string => typeof c === 'string' && c.length > 0).map((c) => c.toUpperCase()),
        equipmentId: d.equipmentId ?? null,
      };
    });
}

export function toSourcePhotos(photos: PhotoRef[]): SourcePhoto[] {
  return photos
    .filter((p) => !!p.s3Key)
    .sort((a, b) => (a.isPrimary === b.isPrimary ? a.displayOrder - b.displayOrder : a.isPrimary ? -1 : 1))
    .map((p) => ({
      id: p.id,
      fileId: p.fileId,
      s3Key: p.s3Key,
      s3Bucket: p.s3Bucket,
      mimeType: p.mimeType,
      fileName: p.originalFilename,
      sizeBytes: p.size,
      displayOrder: p.displayOrder,
      isPrimary: p.isPrimary,
      caption: p.caption,
      date: asIso(p.documentDate) ?? asIso(p.createdAt),
    }));
}

function toSourceEvents(snapshot: AssetSnapshot, agenda: Array<{
  id: number; title: string; description: string | null; startDate: unknown; manualStatus: string | null; occurrenceNature: string | null;
  nature?: SourceEvent['nature']; status4?: AgendaStatus4;
}>): SourceEvent[] {
  const fromEvents: SourceEvent[] = snapshot.events.map((e) => ({
    key: `event:${e.id}`, source: 'event', id: e.id, title: e.title, date: asIso(e.date), category: e.categorie ?? null,
    status: e.statut ?? null, provider: e.provider ?? null, costCents: e.costCents ?? null, description: e.notes ?? null, forecast: false,
  }));
  const fromAgenda: SourceEvent[] = agenda
    .filter((a) => a.manualStatus !== 'annule')
    .map((a) => ({
      key: `agenda:${a.id}`, source: 'agenda', id: a.id, title: a.title, date: asIso(a.startDate), category: null,
      status: a.manualStatus ?? null, provider: null, costCents: null, description: a.description ?? null,
      forecast: a.occurrenceNature === 'FORECAST',
      ...(a.status4 !== undefined ? { nature: a.nature ?? null, status4: a.status4 } : {}),
    }));
  return [...fromEvents, ...fromAgenda];
}

type LoadParams = { assetId: number; accountId: number; userId: number; exportType: DossierCode };

/**
 * Lit les données d'un bien pour un dossier. `accountId` est le compte du
 * bien, déjà vérifié par l'appelant (`findAccessibleAssetForExport`).
 *
 * Commutateur `EXPORTS_CANONICAL_SOURCE` (CDC 15 X-02, lot 16 — voir
 * `canonical-source.ts`) :
 *   · legacy  : lecture historique, strictement inchangée ;
 *   · shadow  : lecture historique UTILISÉE, lecture canonique calculée en
 *               plus (données seulement, aucun rendu), rapport d'écarts sans
 *               valeur journalisé ; un échec du calcul canonique n'affecte
 *               jamais le dossier ;
 *   · enabled : lecture canonique.
 * Toujours : `sourceTrace` (source utilisée, version du registre).
 */
export async function loadExportSource(params: LoadParams): Promise<ExportSource> {
  const { exportsSourceMode, traceOf } = await import('./canonical-source');
  const mode = exportsSourceMode();
  const { source: legacy, snapshot } = await loadLegacyExportSource(params);
  if (mode === 'legacy') return { ...legacy, sourceTrace: traceOf(mode, 'legacy') };
  if (mode === 'enabled') {
    const { source, documentPaths, unconfirmed } = await buildCanonicalExportSource(params, legacy, snapshot);
    return { ...source, sourceTrace: traceOf(mode, 'canonical', { documentPaths, unconfirmedDocuments: unconfirmed }) };
  }
  // shadow
  try {
    const { source: canonical, documentPaths, today, unconfirmed } = await buildCanonicalExportSource(params, legacy, snapshot);
    const { diffExportSources } = await import('./source-diff');
    const diff = diffExportSources(legacy, canonical, { today, documentPaths, unconfirmed });
    // Journal structuré, SANS VALEUR : noms de champs, identifiants, clés.
    console.info('[exports:canonical-shadow]', JSON.stringify({
      assetId: params.assetId, accountId: params.accountId, exportType: params.exportType, ...diff,
    }));
    return {
      ...legacy,
      sourceTrace: traceOf(mode, 'legacy', {
        shadowDiff: {
          fields: diff.fields.length, documentsOnlyLegacy: diff.documents.onlyLegacy.length,
          documentsOnlyCanonical: diff.documents.onlyCanonical.length, events: diff.events.length,
          addedConfirmed: diff.documents.addedInCanonical.confirmed, addedUnconfirmed: diff.documents.addedInCanonical.unconfirmed,
        },
      }),
    };
  } catch (err) {
    console.warn('[exports:canonical-shadow] calcul canonique en échec', {
      assetId: params.assetId, exportType: params.exportType, error: err instanceof Error ? err.message : String(err),
    });
    return { ...legacy, sourceTrace: traceOf(mode, 'legacy', { shadowDiff: { fields: 0, documentsOnlyLegacy: 0, documentsOnlyCanonical: 0, events: 0, failed: true } }) };
  }
}

/**
 * Source canonique, construite SUR la lecture historique : seuls changent
 * les champs du bien, les pièces et l'agenda (photos, pièces de la maison,
 * équipements, informations complémentaires D-12, CIL : identiques).
 */
async function buildCanonicalExportSource(
  params: LoadParams, legacy: ExportSource, snapshot: AssetSnapshot,
): Promise<{ source: ExportSource; documentPaths: ExportSourceTrace['documentPaths']; today: string; unconfirmed: number[] }> {
  const cs = await import('./canonical-source');
  const { pgClient } = await import('@/db');
  const { parisDate } = await import('../generation/clock');
  const today = parisDate();
  const row = await cs.loadAssetRow(pgClient as never, params.assetId, params.accountId);
  if (!row) throw Object.assign(new Error(`Bien ${params.assetId} introuvable pour le compte ${params.accountId}`), { exportErrorCode: 'ASSET_NOT_FOUND' });
  const state = cs.buildCanonicalAssetState(row);
  const [docs, agenda] = await Promise.all([
    cs.loadCanonicalDocuments(params.accountId, params.assetId),
    cs.loadCanonicalAgenda(params.accountId, params.assetId, today),
  ]);
  const scalars = cs.canonicalAssetScalars(state, {
    purchaseDate: legacy.asset.purchaseDate, purchasePriceCents: legacy.asset.purchasePriceCents,
    warrantyEndDate: legacy.asset.warrantyEndDate, mileageOrHours: legacy.asset.mileageOrHours,
    registrationNumber: legacy.asset.registrationNumber, dimensions: legacy.asset.dimensions,
    engineInfo: legacy.asset.engineInfo, purchaseLocation: legacy.asset.purchaseLocation,
    address: legacy.asset.address, postalCode: legacy.asset.postalCode, city: legacy.asset.city,
    generalCondition: legacy.asset.generalCondition, objectCategory: legacy.asset.objectCategory,
    description: legacy.asset.description,
  });
  const photoFileIds = new Set(snapshot.photos.map((p) => p.fileId).filter((x): x is number => x != null));
  return {
    today,
    documentPaths: docs.paths,
    unconfirmed: docs.unconfirmed,
    source: {
      ...legacy,
      asset: {
        ...legacy.asset,
        ...scalars,
        characteristics: cleanCharacteristics(cs.canonicalCharacteristics(row, state)),
      },
      // Rattachement non confirmé : proposé décoché (relecture lot 16).
      documents: toSourceDocuments(docs.documents, photoFileIds)
        .map((d) => (docs.unconfirmed.includes(d.id) ? { ...d, unconfirmedLink: true } : d)),
      events: toSourceEvents(snapshot, agenda.map((a) => ({
        id: a.id, title: a.title, description: a.description, startDate: a.startDate, manualStatus: a.manualStatus,
        occurrenceNature: a.occurrenceNature, nature: a.nature, status4: a.status4,
      }))),
    },
  };
}

/** Lecture historique (inchangée) ; rend aussi le snapshot lu. */
async function loadLegacyExportSource(params: LoadParams): Promise<{ source: ExportSource; snapshot: AssetSnapshot }> {
  const { assetId, accountId, userId, exportType } = params;
  const [assetRow] = await db.select().from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
  if (!assetRow) throw Object.assign(new Error(`Bien ${assetId} introuvable pour le compte ${accountId}`), { exportErrorCode: 'ASSET_NOT_FOUND' });

  const snapshot = await buildAssetSnapshot(assetId, userId, { accountId });
  const family = toExportFamily(assetRow.category) ?? 'OBJET';

  const [infos, agenda, equipRows, author] = await Promise.all([
    getAssetAdditionalInfos(assetId, accountId),
    db.select({
      id: agendaItems.id, title: agendaItems.title, description: agendaItems.description, startDate: agendaItems.startDate,
      manualStatus: agendaItems.manualStatus, occurrenceNature: agendaItems.occurrenceNature,
    }).from(agendaItems)
      .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
      .where(and(eq(agendaAssetLinks.assetId, assetId), eq(agendaItems.accountId, accountId))),
    db.select({
      id: equipments.id, name: equipments.name, type: equipments.type, category: equipments.category,
      brand: equipmentCilSpecs.brand, model: equipmentCilSpecs.model, energyType: equipmentCilSpecs.energyType,
    }).from(equipments)
      .leftJoin(equipmentCilSpecs, eq(equipmentCilSpecs.equipmentId, equipments.id))
      .where(and(eq(equipments.assetId, assetId), isNull(equipments.archivedAt))),
    db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId)).limit(1),
  ]);

  let cil: SourceCil | null = null;
  if (exportType === 'CIL') {
    const [readiness, profiles, materials, works, resolutions] = await Promise.all([
      evaluateCilReadiness(assetRow),
      db.select().from(assetCilProfiles).where(eq(assetCilProfiles.assetId, assetId)).limit(1),
      db.select().from(energyMaterials).where(eq(energyMaterials.assetId, assetId)),
      db.select().from(energyWorks).where(eq(energyWorks.assetId, assetId)),
      db.select().from(cilBlockResolutions).where(eq(cilBlockResolutions.assetId, assetId)),
    ]);
    const p = profiles[0];
    cil = {
      readiness,
      profile: p ? { triggerType: p.triggerType, triggerDate: asIso(p.triggerDate), authorizationType: p.authorizationType, voluntaryReason: p.voluntaryReason } : null,
      materials: materials.map((m) => ({
        id: m.id, category: m.category, materialNature: m.materialNature, brand: m.brand, reference: m.reference,
        thermalResistanceR: m.thermalResistanceR, lambda: m.lambda, thicknessMm: m.thicknessMm, documentId: m.documentId,
      })),
      works: works.map((w) => ({ id: w.id, category: w.category, title: w.title, description: w.description, completedAt: asIso(w.completedAt), companyName: w.companyName })),
      resolutions: resolutions.map((r) => ({ blockId: r.blockId, resolution: r.resolution, justification: r.justification })),
    };
  }

  const photoFileIds = new Set(snapshot.photos.map((p) => p.fileId).filter((x): x is number => x != null));
  const name = [author[0]?.firstName, author[0]?.lastName].filter((x) => x && x.trim()).join(' ').trim();

  const source: ExportSource = {
    exportType,
    family,
    asset: {
      id: assetRow.id,
      publicId: assetRow.publicId,
      name: assetRow.name,
      category: assetRow.category,
      subtype: assetRow.subtype,
      objectCategory: assetRow.objectCategory,
      status: assetRow.status,
      generalCondition: assetRow.generalCondition,
      purchaseDate: asIso(assetRow.purchaseDate),
      purchasePriceCents: assetRow.purchasePriceCents,
      warrantyEndDate: asIso(assetRow.warrantyEndDate),
      mileageOrHours: assetRow.mileageOrHours,
      registrationNumber: assetRow.registrationNumber,
      dimensions: assetRow.dimensions,
      engineInfo: assetRow.engineInfo,
      purchaseLocation: assetRow.purchaseLocation,
      address: assetRow.address,
      postalCode: assetRow.postalCode,
      city: assetRow.city,
      description: snapshot.description,
      characteristics: cleanCharacteristics(snapshot.keyCharacteristics),
      equipmentList: snapshot.equipmentList,
    },
    documents: toSourceDocuments(snapshot.documents, photoFileIds),
    photos: toSourcePhotos(snapshot.photos),
    events: toSourceEvents(snapshot, agenda),
    equipments: equipRows,
    rooms: snapshot.substructures.map((s) => ({ id: s.id, name: s.name })),
    additionalInfo: {
      commercial: { ...(infos.commercial ?? {}) },
      rental: { ...(infos.rental ?? {}) },
      insurance: { ...(infos.insurance ?? {}) },
      claim: { ...(infos.claim ?? {}) },
      finance: { ...(infos.finance ?? {}) },
      updatedAt: infos.updatedAt ?? null,
    },
    cil,
    preparedBy: name || null,
  };
  return { source, snapshot };
}
