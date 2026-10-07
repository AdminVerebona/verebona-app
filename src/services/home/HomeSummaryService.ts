/**
 * HomeSummaryService — données de l'accueil Direction D v2 « La mascotte ».
 *
 * L'accueil n'affiche plus de cartes statistiques ni de blocs « À faire »,
 * « Prochaines dates », « À savoir », « Activité récente » (§2) : ils ne
 * sont plus calculés. Restent l'état du compte (compte vide), les biens
 * (grille « Mes biens »), « Ce que j'ai fait » et « Documents récents ». La
 * prise de parole vient de `services/home/mascot` (GET /api/home/mascot).
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, assets, assetFiles, assetFileThumbnails, documentTypes, accounts, aiFieldUpdates,
} from '@/db/schema';
import { decideThumbnail, thumbnailSourceKind, THUMBNAIL_VARIANT } from '@/services/documents/thumbnails/thumbnail-spec';
import { eq, and, or, isNull, isNotNull, gte, lte, sql, inArray, notInArray, desc, asc } from 'drizzle-orm';
import { getToProcessPage } from '@/services/to-process/to-process-query.service';
import {
  deriveUpcoming, deriveVerebonaWork, docStatus, docTone,
  type HomeRecentDocument, type HomeUpcomingItem, type VerebonaWorkItem,
} from '@/services/home/home-blocks';
import { isAgendaActionItemT4 } from '@/services/home/mascot/collector';
import { upcomingDeadlinesSqlFilter } from '@/services/agenda/AgendaQueryService';
import { getRubric } from '@/lib/referential/v2';
import { aiFieldUpdatesTargetReady } from '@/services/canonical/entity-state/entity-schema';
import {
  fieldUpdateTargetColumns, registryFieldLabel, visibleFieldUpdatesWhere,
} from '@/services/canonical/entity-state/ai-field-updates-target';

// Champs visibles par l'utilisateur dans l'UI — les autres champs (techniques)
// sont filtrés de « Ce que j'ai fait ».
const ENRICH_VISIBLE_FIELDS = [
  'name', 'subCategory', 'description', 'acquisitionDate', 'acquisitionPrice',
  'vehicleOwnershipStatus', 'notes',
  'address1', 'address2', 'postalCode', 'city', 'country', 'cadastralRef', 'lotNumber', 'floor', 'gpsCoords',
  'livingArea', 'landArea', 'roomCount', 'bedroomCount', 'levels', 'constructionYear', 'generalCondition',
  'occupancyUsage', 'occupancyStatus', 'monthlyRent', 'charges', 'occupancyNotes',
  'heatingType', 'mainEnergy', 'dpeClass', 'dpeDate', 'gesClass', 'networks',
  'estimatedValue', 'valuationSource', 'valuationDate',
  'make', 'model', 'registrationNumber', 'vin', 'year',
  'engine', 'fuelType', 'fiscalHp', 'powerKw', 'ptac', 'seats', 'firstRegistrationDate',
  'mileage', 'mileageUnit', 'mileageDate', 'primaryUse',
  'isInsured', 'insurer', 'insuranceExpiry', 'insuranceContractNumber', 'insuranceClientNumber', 'insurancePremium', 'nextInspection',
  'objectCategory', 'brand', 'modelName', 'serialNumber',
  'condition', 'dimensions', 'weight', 'accessories',
  'acquisitionMode', 'provenance', 'authenticityProof',
  'storageLocation', 'lastRevision',
];

// ── Types exportés ──────────────────────────────────────────────────────────

export type SituationStatus = 'actions_required' | 'all_clear' | 'empty';

export interface HomeSituation {
  status: SituationStatus;
  /** Actions « À traiter » ouvertes (même source que la pastille de navigation). */
  todoCount: number;
}

export interface HomeAsset {
  id: number;
  name: string;
  category: string;
  subtype?: string | null;
  status?: string | null;
  thumbnailUrl?: string | null;
  signedThumbnailUrl?: string | null;
  documentCount: number;
  documentLabels: string[];
  // micro-signaux
  todoCount: number;          // actions rattachées au bien (pastille de la carte)
  nextDate?: string | null;   // prochaine date d'agenda liée à ce bien
  nextDateTitle?: string | null;
}

export interface HomeSummaryPayload {
  situation: HomeSituation;
  blocks: {
    /** « Ce que j'ai fait » — Direction D v2 §3.4, 1re personne. */
    verebonaWork: { items: VerebonaWorkItem[] };
    /** « Documents récents » — Direction D v2 §3.5 (4 tuiles). */
    recentDocuments: { items: HomeRecentDocument[] };
    /** « Prochaines échéances » — prototype D v2 (décision produit), 5 au plus. */
    upcoming: { items: HomeUpcomingItem[] };
  };
  assets: { items: HomeAsset[]; total: number };
  /** Total des documents du compte (compte vide, §12ter). */
  documents: { total: number };
  plan: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** « Fin de garantie » → « fin de garantie » (un sigle en tête garde sa casse). */
function minusculeLibelle(t: string): string {
  return /^[A-ZÀ-Ý][a-zà-ÿ’' ]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function dateMinus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Aperçus des « Documents récents » (lot 26, point 16) ────────────────────

export interface RecentDocPreviewRow {
  id: number;
  s3Key: string | null;
  mimeType: string | null;
  fileExtension: string | null;
  originalFilename: string | null;
  isWebLink: boolean | null;
  thumbStatus: string | null;
  thumbSourceKey: string | null;
  thumbS3Key: string | null;
  thumbAttempts: number | null;
  thumbLeaseUntil: Date | null;
  thumbUpdatedAt: Date | null;
}

export interface RecentDocPreviewDeps {
  enabled: () => boolean;
  sign: (s3Key: string) => Promise<string>;
  enqueue: (fileId: number) => void;
}

const defaultPreviewDeps = async (): Promise<RecentDocPreviewDeps> => {
  const [{ thumbnailsEnabled, enqueueThumbnail }, { signedThumbnailUrl }] = await Promise.all([
    import('@/services/documents/thumbnails/thumbnail.service'),
    import('@/services/documents/thumbnails/thumbnail-url'),
  ]);
  return { enabled: thumbnailsEnabled, sign: (k) => signedThumbnailUrl(k), enqueue: (id) => { enqueueThumbnail(id); } };
};

/**
 * URL d'aperçu des documents récents : la miniature PRÊTE de la version
 * courante, par URL signée mémorisée (au plus une signature locale par dérivé
 * et par heure — aucune requête au stockage). Miniature absente ou périmée :
 * pas d'aperçu (icône) et génération demandée — rattrapage immédiat des
 * documents existants, en plus de la tâche horaire `hourly-thumbnails-backfill`.
 * Ne lève jamais : un aperçu manquant ne doit pas priver l'accueil du reste.
 */
export async function recentDocumentPreviews(
  rows: RecentDocPreviewRow[],
  depsP: Promise<RecentDocPreviewDeps> | RecentDocPreviewDeps = defaultPreviewDeps(),
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const deps = await depsP;
    if (!deps.enabled()) return out;
    await Promise.all(rows.map(async (r) => {
      if (!r.s3Key || !thumbnailSourceKind(r)) return;
      const row = r.thumbStatus && r.thumbSourceKey && r.thumbUpdatedAt
        ? {
            status: r.thumbStatus, sourceKey: r.thumbSourceKey, s3Key: r.thumbS3Key,
            attempts: r.thumbAttempts ?? 0, leaseUntil: r.thumbLeaseUntil, updatedAt: r.thumbUpdatedAt,
          }
        : null;
      const decision = decideThumbnail(row, r.s3Key);
      if (decision.action === 'serve') {
        try { out.set(r.id, await deps.sign(decision.s3Key)); } catch { /* icône */ }
      } else if (decision.action === 'generate') {
        deps.enqueue(r.id);
      }
    }));
  } catch (e) {
    console.warn('[accueil] aperçus des documents récents indisponibles :', (e as Error).message);
  }
  return out;
}

// ── Service principal ────────────────────────────────────────────────────────

export async function buildHomeSummary(accountId: number): Promise<HomeSummaryPayload> {
  const today = todayStr();

  // CDC 15 D-14, T4-02 (0223 appliquée) : les échéances AUTOMATIQUES entrent
  // dans l'accueil, les faits HISTORICAL jamais (filtre de B) ; la catégorie
  // vient de l'élément lui-même. 0223 absente : sans les automatiques (hors
  // prévisions), faute de nature pour écarter les faits passés.
  const filtreT4 = await upcomingDeadlinesSqlFilter('agenda_items');
  const t4 = filtreT4 !== '';
  // Cible des lignes `ai_field_updates` (0236, lot 22) : équipements et pièces.
  const cible = await aiFieldUpdatesTargetReady();
  const cibleCols = fieldUpdateTargetColumns(cible);

  const [
    accountRows,
    agendaRows,
    assetRows,
    totalAssetsRow,
    totalDocumentsRow,
    docTypesRows,
    latestDocs,
    workFieldRows,
    workDeadlineRows,
    workDocumentRows,
  ] = await Promise.all([
    db.select({ planType: accounts.planType }).from(accounts).where(eq(accounts.id, accountId)).limit(1),

    // Échéances actives (non réalisées, non annulées) : prochaine date et
    // actions sans date par bien, et détection du compte vide.
    db.select({
      id: agendaItems.id,
      title: agendaItems.title,
      startDate: agendaItems.startDate,
      originType: agendaItems.originType,
      homeCategory: agendaItems.homeCategory,
      occurrenceNature: agendaItems.occurrenceNature,
      originFieldKey: agendaItems.originFieldKey,
      // Colonnes 0223 : non déclarées dans Drizzle, lues seulement si présentes.
      eventNature: t4 ? sql<string | null>`agenda_items.event_nature` : sql<string | null>`NULL::text`,
      businessType: t4 ? sql<string | null>`agenda_items.business_type` : sql<string | null>`NULL::text`,
    })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        or(isNull(agendaItems.manualStatus), sql`trim(${agendaItems.manualStatus}) = ''`),
        t4
          ? sql.raw(filtreT4.replace(/^\s*AND\s*/, ''))
          : or(eq(agendaItems.isAutomatic, false), eq(agendaItems.occurrenceNature, 'FORECAST')),
        gte(agendaItems.startDate, dateMinus(365)),
        lte(agendaItems.startDate, dateIn(730)),
      ))
      .orderBy(asc(agendaItems.startDate)),

    // Biens actifs (hors archivé/transmis) — limité à 20 pour la home
    db.select({
      id: assets.id,
      name: assets.name,
      category: assets.category,
      subtype: assets.subtype,
      status: assets.status,
      thumbnailUrl: assets.thumbnailUrl,
      createdAt: assets.createdAt,
    })
      .from(assets)
      .where(and(
        eq(assets.accountId, accountId),
        isNull(assets.deletedAt),
        notInArray(assets.status, ['ARCHIVED', 'TRANSMIS']),
      ))
      .orderBy(desc(assets.createdAt))
      .limit(20),

    db.select({ count: sql<number>`count(*)` })
      .from(assets)
      .where(and(
        eq(assets.accountId, accountId),
        isNull(assets.deletedAt),
        notInArray(assets.status, ['ARCHIVED', 'TRANSMIS']),
      )),

    // Total documents (liens web compris ; hors supprimés et envois inachevés).
    db.select({ count: sql<number>`count(*)` })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
      )),

    db.select({ code: documentTypes.code, label: documentTypes.label })
      .from(documentTypes)
      .where(eq(documentTypes.isActive, true)),

    // ── Direction D v2 ─────────────────────────────────────────────────────
    // Documents récents (§3.5) : les 4 derniers déposés, sans borne de date,
    // avec leur bien et leur état d'analyse.
    db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      webLinkTitle: assetFiles.webLinkTitle,
      documentType: assetFiles.documentType,
      rubricCode: assetFiles.rubricCode,
      documentDate: assetFiles.documentDate,
      uploadedAt: assetFiles.uploadedAt,
      analysisState: assetFiles.analysisState,
      assetId: assetFiles.assetId,
      assetName: assets.name,
      // Aperçu (lot 26, point 16) : état de la miniature lu dans la MÊME
      // requête (jointure sur la clé unique fichier × variante) — pas de N+1.
      s3Key: assetFiles.s3Key,
      mimeType: assetFiles.mimeType,
      fileExtension: assetFiles.fileExtension,
      isWebLink: assetFiles.isWebLink,
      thumbStatus: assetFileThumbnails.status,
      thumbSourceKey: assetFileThumbnails.sourceKey,
      thumbS3Key: assetFileThumbnails.s3Key,
      thumbAttempts: assetFileThumbnails.attempts,
      thumbLeaseUntil: assetFileThumbnails.leaseUntil,
      thumbUpdatedAt: assetFileThumbnails.updatedAt,
    })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .leftJoin(assetFileThumbnails, and(
        eq(assetFileThumbnails.fileId, assetFiles.id),
        eq(assetFileThumbnails.variant, THUMBNAIL_VARIANT),
      ))
      .where(and(
        eq(assetFiles.accountId, accountId),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        isNull(assetFiles.deletedAt),
      ))
      .orderBy(desc(assetFiles.uploadedAt), desc(assetFiles.id))
      .limit(4),

    // « Ce que j'ai fait » (§3.4) — champs complétés par l'analyse (30 jours),
    // ceux du bien et ceux de ses équipements / pièces (lot 22).
    db.select({
      assetId: aiFieldUpdates.assetId,
      assetName: assets.name,
      fieldKey: aiFieldUpdates.fieldKey,
      assetFileId: aiFieldUpdates.assetFileId,
      createdAt: aiFieldUpdates.createdAt,
      targetType: cibleCols.targetType,
      entityName: cibleCols.entityName,
    })
      .from(aiFieldUpdates)
      .innerJoin(assets, eq(aiFieldUpdates.assetId, assets.id))
      .where(and(
        eq(aiFieldUpdates.accountId, accountId),
        gte(aiFieldUpdates.createdAt, new Date(dateMinus(30) + 'T00:00:00')),
        isNull(assets.deletedAt),
        visibleFieldUpdatesWhere(cible, ENRICH_VISIBLE_FIELDS),
      ))
      .orderBy(desc(aiFieldUpdates.createdAt))
      .limit(40),

    // Échéances lues dans un document (30 jours).
    db.select({
      id: agendaItems.id,
      title: agendaItems.title,
      startDate: agendaItems.startDate,
      createdAt: agendaItems.createdAt,
      originRefType: agendaItems.originRefType,
      originRefId: agendaItems.originRefId,
    })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        eq(agendaItems.originType, 'qualified_document'),
        isNotNull(agendaItems.createdAt),
        gte(agendaItems.createdAt, new Date(dateMinus(30) + 'T00:00:00')),
      ))
      .orderBy(desc(agendaItems.createdAt))
      .limit(5),

    // Documents analysés récemment (30 jours).
    db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      analysisState: assetFiles.analysisState,
      lastAnalysisAt: assetFiles.lastAnalysisAt,
      uploadedAt: assetFiles.uploadedAt,
      assetName: assets.name,
    })
      .from(assetFiles)
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(and(
        eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt),
        isNotNull(assetFiles.analysisState),
        // Borne passée en texte typé : une `Date` comparée à une expression SQL
        // brute (sans colonne pour l'encoder) est refusée par le pilote.
        gte(sql`coalesce(${assetFiles.lastAnalysisAt}, ${assetFiles.uploadedAt})`, sql`${new Date(dateMinus(30) + 'T00:00:00').toISOString()}::timestamptz`),
      ))
      .orderBy(desc(sql`coalesce(${assetFiles.lastAnalysisAt}, ${assetFiles.uploadedAt})`))
      .limit(5),

    ]);

  const planType = accountRows[0]?.planType ?? 'STANDARD';
  const docTypeMap: Record<string, string> = {};
  docTypesRows.forEach(dt => { docTypeMap[dt.code] = dt.label; });

  // ── Liens agenda→asset ────────────────────────────────────────────────────
  const agendaIds = agendaRows.map(a => a.id);
  const agendaAssetLinksRows = agendaIds.length > 0
    ? await db.select({
        agendaItemId: agendaAssetLinks.agendaItemId,
        assetId: agendaAssetLinks.assetId,
        assetName: assets.name,
      })
        .from(agendaAssetLinks)
        .leftJoin(assets, eq(agendaAssetLinks.assetId, assets.id))
        .where(inArray(agendaAssetLinks.agendaItemId, agendaIds))
    : [];

  const agendaAssetMap: Record<number, { assetId: number; assetName: string }[]> = {};
  agendaAssetLinksRows.forEach(row => {
    if (!agendaAssetMap[row.agendaItemId]) agendaAssetMap[row.agendaItemId] = [];
    if (row.assetId) agendaAssetMap[row.agendaItemId].push({ assetId: row.assetId, assetName: row.assetName ?? '' });
  });

  // ── Statistiques biens (docs + prochaine date) ────────────────────────────
  const assetIds = assetRows.map(a => a.id);
  const assetDocStats: Record<number, { count: number; labels: string[] }> = {};
  const assetNextDate: Record<number, { date: string; title: string }> = {};

  if (assetIds.length > 0) {
    const [assetDocsRows] = await Promise.all([
      db.select({
        assetId: assetFiles.assetId,
        documentType: assetFiles.documentType,
      })
        .from(assetFiles)
        .where(and(
          eq(assetFiles.accountId, accountId),
          inArray(assetFiles.assetId, assetIds),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt),
        )),
    ]);

    assetDocsRows.forEach(f => {
      if (!f.assetId) return;
      if (!assetDocStats[f.assetId]) assetDocStats[f.assetId] = { count: 0, labels: [] };
      assetDocStats[f.assetId].count++;
      const label = f.documentType ? (docTypeMap[f.documentType] || f.documentType) : null;
      if (label && label.toUpperCase() !== 'AUTRE' && !assetDocStats[f.assetId].labels.includes(label) && assetDocStats[f.assetId].labels.length < 3) {
        assetDocStats[f.assetId].labels.push(label);
      }
    });

    // Prochaine date par bien (via agenda asset links)
    agendaRows.forEach(item => {
      if (!item.startDate || item.startDate < today) return;
      const links = agendaAssetMap[item.id] ?? [];
      links.forEach(({ assetId }) => {
        if (!assetIds.includes(assetId)) return;
        if (!assetNextDate[assetId] || item.startDate! < assetNextDate[assetId].date) {
          assetNextDate[assetId] = { date: item.startDate!, title: item.title };
        }
      });
    });
  }

  // ── Comptage todo par bien ────────────────────────────────────────────────
  const assetTodoCount: Record<number, number> = {};
  agendaRows.forEach(item => {
    if (!item.startDate) {
      // agenda sans date → action requise
      const links = agendaAssetMap[item.id] ?? [];
      links.forEach(({ assetId }) => {
        if (assetIds.includes(assetId)) {
          assetTodoCount[assetId] = (assetTodoCount[assetId] ?? 0) + 1;
        }
      });
    }
  });

  // « À traiter » : même file que la page et la pastille de navigation.
  const actionsV2 = await getToProcessPage(accountId, { orderMode: 'BY_PRIORITY' });
  const totalTodo = actionsV2.total;

  // Libellés lisibles des champs complétés.
  const KC_LABELS: Record<string, string> = {
    acquisitionDate: 'date d\'acquisition', acquisitionPrice: 'prix d\'acquisition',
    acquisitionLocation: 'lieu d\'acquisition', estimatedValue: 'valeur estimée',
    address1: 'adresse', address2: 'adresse (complément)', city: 'ville', postalCode: 'code postal',
    country: 'pays', cadastralRef: 'référence cadastrale', lotNumber: 'numéro de lot',
    floor: 'étage',
    livingArea: 'surface habitable', landArea: 'surface terrain',
    roomCount: 'nombre de pièces', bedroomCount: 'nombre de chambres',
    constructionYear: 'année de construction', heatingType: 'type de chauffage',
    dpeClass: 'classe DPE', dpeDate: 'date DPE', gesClass: 'classe GES',
    occupancyStatus: 'statut d\'occupation', monthlyRent: 'loyer mensuel',
    make: 'marque', model: 'modèle', registrationNumber: 'immatriculation',
    year: 'année', fuelType: 'carburant', mileage: 'kilométrage',
    firstRegistrationDate: '1ère mise en circulation',
    insurer: 'assureur', isInsured: 'statut assurance',
    insuranceContractNumber: 'n° de contrat assurance', insuranceClientNumber: 'n° de client assurance',
    insuranceExpiry: 'échéance assurance', insurancePremium: 'prime assurance',
    nextInspection: 'prochain CT',
    fiscalHp: 'puissance fiscale', powerKw: 'puissance (kW)', ptac: 'PTAC',
    engine: 'motorisation', seats: 'nombre de places', vin: 'numéro VIN',
    brand: 'marque', modelName: 'modèle', serialNumber: 'numéro de série',
    condition: 'état', objectCategory: 'catégorie',
    name: 'nom du bien', description: 'description',
  };

  // ── Direction D v2 : « Ce que j'ai fait » et « Documents récents » ────────
  // Documents d'origine des échéances lues, et biens de ces échéances.
  const workDocIds = workDeadlineRows
    .filter((r) => r.originRefType === 'asset_file' && r.originRefId)
    .map((r) => r.originRefId as number);
  const workAgendaIds = workDeadlineRows.map((r) => r.id);
  const [workDocTitles, workAgendaAssets] = await Promise.all([
    workDocIds.length > 0
      ? db.select({ id: assetFiles.id, originalFilename: assetFiles.originalFilename, retainedTitle: assetFiles.retainedTitle })
          .from(assetFiles)
          .where(and(eq(assetFiles.accountId, accountId), inArray(assetFiles.id, workDocIds), isNull(assetFiles.deletedAt)))
      : Promise.resolve([] as Array<{ id: number; originalFilename: string | null; retainedTitle: string | null }>),
    workAgendaIds.length > 0
      ? db.select({ agendaItemId: agendaAssetLinks.agendaItemId, assetName: assets.name })
          .from(agendaAssetLinks)
          .leftJoin(assets, eq(agendaAssetLinks.assetId, assets.id))
          .where(inArray(agendaAssetLinks.agendaItemId, workAgendaIds))
      : Promise.resolve([] as Array<{ agendaItemId: number; assetName: string | null }>),
  ]);
  const docTitleById = new Map(workDocTitles.map((d) => [d.id, d.retainedTitle || d.originalFilename || 'Document']));
  const isoOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : new Date(0).toISOString());

  const verebonaWork = deriveVerebonaWork({
    // Ligne d'entité dont l'équipement / la pièce n'existe plus : rien à montrer.
    fieldUpdates: workFieldRows.filter((r) => !r.targetType || r.entityName != null).map((r) => ({
      assetId: r.assetId,
      assetName: r.assetName,
      fieldKey: r.fieldKey,
      fieldLabel: KC_LABELS[r.fieldKey] ?? minusculeLibelle(registryFieldLabel(r.fieldKey)),
      assetFileId: r.assetFileId ?? null,
      createdAt: isoOf(r.createdAt),
      entityLabel: r.targetType ? r.entityName : null,
      entityTab: r.targetType === 'EQUIPMENT' ? 'equipments' as const : r.targetType === 'ROOM' ? 'rooms' as const : null,
    })),
    deadlines: workDeadlineRows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.startDate ?? null,
      createdAt: isoOf(r.createdAt),
      documentId: r.originRefType === 'asset_file' ? r.originRefId ?? null : null,
      documentTitle: r.originRefType === 'asset_file' && r.originRefId ? docTitleById.get(r.originRefId) ?? null : null,
      assetName: workAgendaAssets.find((l) => l.agendaItemId === r.id)?.assetName ?? null,
    })),
    documents: workDocumentRows.map((r) => ({
      id: r.id,
      title: r.retainedTitle || r.originalFilename || 'Document',
      assetName: r.assetName ?? null,
      analysisState: r.analysisState,
      at: isoOf(r.lastAnalysisAt ?? r.uploadedAt),
    })),
  });

  const previews = await recentDocumentPreviews(latestDocs);
  const recentDocuments: HomeRecentDocument[] = latestDocs.map((d) => {
    const typeLabel = d.documentType ? (docTypeMap[d.documentType] || null) : null;
    const rubrique = getRubric(d.rubricCode)?.label ?? null;
    const dateUtile = d.documentDate ?? (d.uploadedAt ? new Date(d.uploadedAt).toISOString().slice(0, 10) : null);
    return {
      id: d.id,
      title: d.retainedTitle || d.webLinkTitle || d.originalFilename || 'Document',
      assetId: d.assetId ?? null,
      assetName: d.assetName ?? null,
      typeLabel: (typeLabel && typeLabel.toUpperCase() !== 'AUTRE' ? typeLabel : null) ?? rubrique ?? 'Document',
      date: dateUtile ? String(dateUtile).slice(0, 10) : null,
      status: docStatus(d.analysisState),
      tone: docTone(d.rubricCode),
      previewUrl: previews.get(d.id) ?? null,
    };
  });

  // Pastille d'action des cartes de biens : actions « À traiter » ouvertes
  // sur le bien, en plus des échéances sans date.
  for (const a of actionsV2.actions) {
    const id = a.target.assetId;
    if (id && assetIds.includes(id)) assetTodoCount[id] = (assetTodoCount[id] ?? 0) + 1;
  }

  // « Prochaines échéances » : échéances actives du compte (ni réalisées, ni
  // annulées — filtre de la requête), bornées par l'horizon de la requête.
  const upcoming = deriveUpcoming(
    agendaRows
      .filter((i) => !!i.startDate)
      .map((i) => ({
        id: i.id,
        title: i.title,
        date: String(i.startDate),
        assetName: agendaAssetMap[i.id]?.[0]?.assetName ?? null,
        forecast: i.occurrenceNature === 'FORECAST',
        action: isAgendaActionItemT4({
          homeCategory: i.homeCategory, originType: i.originType, title: i.title,
          eventNature: i.eventNature, businessType: i.businessType, originFieldKey: i.originFieldKey,
        }),
      })),
    today,
  );

  const isEmpty = assetRows.length === 0 && agendaRows.length === 0;

  // Les signed URLs S3 sont intentionnellement absentes ici pour ne pas bloquer
  // le rendu initial. Elles sont chargées côté client via useThumbnailUrl (cache 55 min).
  const enrichedAssets: HomeAsset[] = assetRows.map((asset) => {
    const stats = assetDocStats[asset.id] ?? { count: 0, labels: [] };
    const next = assetNextDate[asset.id] ?? null;
    const todoC = assetTodoCount[asset.id] ?? 0;
    return {
      id: asset.id,
      name: asset.name,
      category: asset.category,
      subtype: asset.subtype,
      status: asset.status,
      thumbnailUrl: asset.thumbnailUrl,
      signedThumbnailUrl: null,
      documentCount: stats.count,
      documentLabels: stats.labels,
      todoCount: todoC,
      nextDate: next?.date ?? null,
      nextDateTitle: next?.title ?? null,
    };
  });

  return {
    situation: {
      status: isEmpty ? 'empty' : totalTodo > 0 ? 'actions_required' : 'all_clear',
      todoCount: totalTodo,
    },
    blocks: {
      verebonaWork: { items: verebonaWork },
      recentDocuments: { items: recentDocuments },
      upcoming: { items: upcoming },
    },
    assets: {
      items: enrichedAssets,
      total: Number(totalAssetsRow[0]?.count ?? 0),
    },
    documents: { total: Number(totalDocumentsRow[0]?.count ?? 0) },
    plan: planType,
  };
}
