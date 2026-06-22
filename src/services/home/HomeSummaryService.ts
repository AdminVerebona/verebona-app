/**
 * HomeSummaryService — construit le payload de la home assistant
 * Remplace la logique de compteurs par une classification action/date/info
 */
import { db } from '@/db';
import {
  agendaItems, agendaAssetLinks, assets, assetFiles, documentTypes,
  accounts, exportGenerations, aiFieldUpdates,
} from '@/db/schema';
import { eq, and, or, isNull, isNotNull, gte, lte, sql, inArray, notInArray, desc, asc } from 'drizzle-orm';
import { getToProcessItems } from '@/services/to-process.service';

// Champs visibles par l'utilisateur dans l'UI — les autres champs (techniques) sont filtrés
// de l'affichage enrichissement automatique
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

export type HomeIntent = 'action_required' | 'action_upcoming' | 'information' | 'recent_activity';

export type ActionReason =
  | 'missing_asset'    // document ou agenda sans bien rattaché
  | 'missing_date'     // agenda sans date
  | 'validation_required' // analyse IA à valider (premium)
  | 'overdue_action'   // action en retard
  | 'coherence_alert'  // incohérence détectée entre bien et documents
  // Raisons issues du service À traiter (V2)
  | 'date_conflict'
  | 'document_type_to_confirm'
  | 'missing_required_label'
  | 'asset_suggestion_to_confirm'
  | 'supplier_to_confirm'
  | 'supplier_conflict'
  | 'data_inconsistency';

export type DisplayStatusHome =
  | 'a_faire'
  | 'a_prevoir'
  | 'information'
  | 'passee'
  | 'terminee'
  | 'en_retard';

export type SituationStatus = 'actions_required' | 'all_clear' | 'empty' | 'processing';

export interface HomeItem {
  id: string;
  objectType: 'document' | 'agenda' | 'equipment' | 'system' | 'asset' | 'supplier';
  objectId: number;
  homeIntent: HomeIntent;
  reason?: ActionReason;
  title: string;
  /** Texte narratif riche : **gras** pour les mots clés */
  richText?: string;
  /** 'check' = info neutre/positive, 'sparkle' = IA/détection */
  iconType?: 'check' | 'sparkle';
  /** Timestamp ISO pour la ligne de date dans l'activité récente */
  timestamp?: string;
  context?: string | null;
  /** Sous-titre coloré sous le titre (ex: "En retard de 4 jours", "À rattacher à un bien") */
  subLabel?: string | null;
  /** Nombre de propositions IA en attente (pour VALIDATION_REQUIRED) */
  proposalCount?: number | null;
  /** Clé du champ concerné (pour coherence_alert) */
  fieldKey?: string;
  date?: string | null;
  badge: string;
  displayStatus: DisplayStatusHome;
  primaryAction?: string;
}

export interface HomeSituation {
  status: SituationStatus;
  message: string;
  /** Message humain enrichi (peut contenir **gras**) */
  richMessage?: string;
  todoCount?: number;
  upcomingCount?: number;
  firstTodoTitle?: string | null;
  firstTodoContext?: string | null;
  firstUpcomingTitle?: string | null;
  firstUpcomingDate?: string | null;
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
  todoCount: number;          // nb d'actions requises sur ce bien
  nextDate?: string | null;   // prochaine date d'agenda liée à ce bien
  nextDateTitle?: string | null;
}

export interface AutoEnrichmentEvent {
  /** Unique key for React */
  id: string;
  /** Human-readable sentence (can contain **bold** markers) */
  richText: string;
  /** Asset id to navigate to */
  assetId?: number;
  /** Field key to highlight in the details tab */
  fieldKey?: string;
}

export interface HomeSummaryPayload {
  situation: HomeSituation;
  blocks: {
    todo: { items: HomeItem[]; total: number };
    upcoming: { items: HomeItem[]; total: number };
    toKnow: { items: HomeItem[] };
    recentActivity: { items: HomeItem[] };
    autoEnrichment: { events: AutoEnrichmentEvent[] };
  };
  assets: { items: HomeAsset[]; total: number };
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

function dateMinus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatDateFR(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const currentYear = new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() !== currentYear
    ? { day: 'numeric', month: 'long', year: 'numeric' }
    : { day: 'numeric', month: 'long' };
  return d.toLocaleDateString('fr-FR', opts);
}

// ── Service principal ────────────────────────────────────────────────────────

export async function buildHomeSummary(accountId: number): Promise<HomeSummaryPayload> {
  const today = todayStr();

  // Récupérer le plan du compte
  const [accountRow] = await db
    .select({ planType: accounts.planType })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  const planType = accountRow?.planType ?? 'STANDARD';
  const isPremium = planType !== 'STANDARD';

  // ── Requêtes parallèles ───────────────────────────────────────────────────

  const [
    recentDocs,
    agendaRows,
    assetRows,
    totalAssetsRow,
    docTypesRows,
    recentExports,
    recentAgenda,
    recentEnrichedAssets,
  ] = await Promise.all([
    // Documents récents pour l'activité récente (30 jours)
    db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      mimeType: assetFiles.mimeType,
      documentType: assetFiles.documentType,
      uploadedAt: assetFiles.uploadedAt,
      assetId: assetFiles.assetId,
    })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.accountId, accountId),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        isNull(assetFiles.deletedAt),
        eq(assetFiles.isWebLink, false),
        gte(assetFiles.uploadedAt, new Date(dateMinus(30) + 'T00:00:00')),
      ))
      .orderBy(desc(assetFiles.uploadedAt))
      .limit(5),

    // Tous les items agenda actifs (non réalisé, non annulé, non automatique)
    // isAutomatic = true → items générés automatiquement non validés par l'utilisateur, exclus de la home
    db.select({
      id: agendaItems.id,
      title: agendaItems.title,
      startDate: agendaItems.startDate,
      startTime: agendaItems.startTime,
      endDate: agendaItems.endDate,
      endTime: agendaItems.endTime,
      manualStatus: agendaItems.manualStatus,
      requiresQualification: agendaItems.requiresQualification,
      originType: agendaItems.originType,
      homeCategory: agendaItems.homeCategory,
    })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        or(isNull(agendaItems.manualStatus), sql`trim(${agendaItems.manualStatus}) = ''`),
        eq(agendaItems.isAutomatic, false),
        // Horizon : 1 an en arrière, 2 ans en avant — pas besoin de scanner l'infini
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
      keyCharacteristics: assets.keyCharacteristics,
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

    // Total biens
    db.select({ count: sql<number>`count(*)` })
      .from(assets)
      .where(and(
        eq(assets.accountId, accountId),
        isNull(assets.deletedAt),
        notInArray(assets.status, ['ARCHIVED', 'TRANSMIS']),
      )),

    // Types de documents
    db.select({ code: documentTypes.code, label: documentTypes.label })
      .from(documentTypes)
      .where(eq(documentTypes.isActive, true)),

    // Exports PDF récents (30 jours, status ready)
    db.select({
      id: exportGenerations.id,
      exportType: exportGenerations.exportType,
      completedAt: exportGenerations.completedAt,
      assetId: exportGenerations.assetId,
      assetName: assets.name,
    })
      .from(exportGenerations)
      .leftJoin(assets, eq(exportGenerations.assetId, assets.id))
      .where(and(
        eq(exportGenerations.accountId, accountId),
        eq(exportGenerations.status, 'ready'),
        gte(exportGenerations.completedAt, new Date(dateMinus(30) + 'T00:00:00')),
      ))
      .orderBy(desc(exportGenerations.completedAt))
      .limit(3),

    // Éléments agenda créés par l'utilisateur récemment (30 jours)
    // isAutomatic = false : exclut les items purement automatiques (asset_field, deduced_rule…)
    // Les items acceptés depuis une analyse IA (qualified_document) sont inclus car
    // l'utilisateur les a explicitement validés — les propositions refusées ne sont jamais créées en base.
    db.select({
      id: agendaItems.id,
      title: agendaItems.title,
      createdAt: agendaItems.createdAt,
    })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        isNotNull(agendaItems.createdAt),
        gte(agendaItems.createdAt, new Date(dateMinus(30) + 'T00:00:00')),
        eq(agendaItems.isAutomatic, false),
      ))
      .orderBy(desc(agendaItems.createdAt))
      .limit(5),

    // Enrichissements IA récents (30 jours) — lire directement aiFieldUpdates
    // pour avoir la liste exacte des champs modifiés par bien
    db.select({
        assetId:   aiFieldUpdates.assetId,
        assetName: assets.name,
        fieldKey:  aiFieldUpdates.fieldKey,
        newValue:  aiFieldUpdates.newValue,
        createdAt: aiFieldUpdates.createdAt,
      })
        .from(aiFieldUpdates)
        .innerJoin(assets, eq(aiFieldUpdates.assetId, assets.id))
        .where(and(
          eq(aiFieldUpdates.accountId, accountId),
          gte(aiFieldUpdates.createdAt, new Date(dateMinus(30) + 'T00:00:00')),
          isNull(assets.deletedAt),
          inArray(aiFieldUpdates.fieldKey, ENRICH_VISIBLE_FIELDS),
        ))
        .orderBy(desc(aiFieldUpdates.createdAt))
        .limit(5),

    ]);

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

  // ── Bloc A FAIRE — from unified À traiter service ──────────────────
  const toProcessResult = await getToProcessItems(accountId);

  const actionLabels: Record<string, string> = {
    choose_asset: 'Associer',
    choose_date: 'Choisir',
    confirm: 'Confirmer',
    resolve: 'Résoudre',
    add_date: 'Ajouter la date',
    fill: 'Renseigner',
    keep_separate: 'Ne pas fusionner',
    merge: 'Fusionner',
    choose_other: 'Choisir',
  };

  const todoItems: HomeItem[] = toProcessResult.items.map(tpItem => {
    const ctxParts: string[] = [];
    if (tpItem.context.assetName) ctxParts.push(tpItem.context.assetName);
    if (tpItem.context.documentFilename) ctxParts.push(tpItem.context.documentFilename);

    return {
      id: tpItem.id,
      objectType: tpItem.objectType,
      objectId: tpItem.objectId,
      homeIntent: 'action_required',
      reason: tpItem.reason as ActionReason,
      title: tpItem.objectTitle,
      subLabel: tpItem.badge,
      context: ctxParts.length > 0 ? ctxParts.join(' · ') : null,
      badge: tpItem.badge,
      displayStatus: 'a_faire',
      primaryAction: actionLabels[tpItem.primaryAction] ?? 'Voir',
    };
  });

  const totalTodo = toProcessResult.total;
  const visibleTodo = todoItems.slice(0, 5);

  // ── Bloc PROCHAINES DATES ─────────────────────────────────────────────────
  // Règle : ACTIONS uniquement
  // homeCategory='action' (ou null = non classifié, traité comme action par défaut)
  // homeCategory='information' → va dans À savoir
  // Fallback sur originType si homeCategory non encore renseigné
  const upcomingItems: HomeItem[] = [];

  function isActionItem(item: { homeCategory: string | null; originType: string; title: string }): boolean {
    if (item.homeCategory === 'action') return true;
    if (item.homeCategory === 'information') return false;
    // homeCategory null → fallback : dates passives (fin assurance, reconduction tacite) → information
    if (/fin.*(p.riode|contrat).*assurance|reconduction|renouvellement.*auto/i.test(item.title)) return false;
    // fallback sur originType
    return item.originType !== 'asset_field';
  }

  const actionAgendaItems = agendaRows.filter(item => isActionItem(item));

  // 1. Items futurs + aujourd'hui (actions, triés par date croissante)
  for (const item of actionAgendaItems) {
    if (upcomingItems.length >= 5) break;
    if (!item.startDate || item.startDate < today) continue;

    const isToday = item.startDate === today;
    const links = agendaAssetMap[item.id] ?? [];
    const context = links[0]?.assetName ?? null;

    upcomingItems.push({
      id: `upcoming_${item.id}`,
      objectType: 'agenda',
      objectId: item.id,
      homeIntent: isToday ? 'action_required' : 'action_upcoming',
      date: item.startDate,
      title: item.title,
      context,
      badge: isToday ? 'Action attendue' : 'À prévoir',
      displayStatus: isToday ? 'a_faire' : 'a_prevoir',
      primaryAction: 'Voir',
    });
  }

  // 2. Items passés en retard (actions non réalisées, non déjà dans À faire)
  for (const item of actionAgendaItems) {
    if (upcomingItems.length >= 7) break;
    if (!item.startDate || item.startDate >= today) continue;
    if (todoItems.some(t => t.id === `agenda_overdue_${item.id}`)) continue;

    const links = agendaAssetMap[item.id] ?? [];
    const context = links[0]?.assetName ?? null;

    upcomingItems.push({
      id: `upcoming_past_${item.id}`,
      objectType: 'agenda',
      objectId: item.id,
      homeIntent: 'action_required',
      date: item.startDate,
      title: item.title,
      context,
      badge: 'En retard',
      displayStatus: 'en_retard',
      primaryAction: 'Voir',
    });
  }

  const totalUpcoming = upcomingItems.length;

  // ── Bloc A SAVOIR ─────────────────────────────────────────────────────────
  // Règle : items informationnels uniquement (homeCategory = 'information')
  // = fins de garantie, échéances auto-générées, fins de décennale
  // Jamais de badge "En retard" — ce sont des faits, pas des actions
  const toKnowItems: HomeItem[] = [];

  const infoAgendaItems = agendaRows
    .filter(item => !isActionItem(item) && item.startDate)
    .sort((a, b) => {
      // Trier : futurs proches en premier (par date asc), puis passés récents (par date desc)
      const aFuture = (a.startDate ?? '') >= today;
      const bFuture = (b.startDate ?? '') >= today;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      if (aFuture && bFuture) return (a.startDate ?? '').localeCompare(b.startDate ?? '');
      return (b.startDate ?? '').localeCompare(a.startDate ?? '');
    })
    .slice(0, 5);

  for (const item of infoAgendaItems) {
    const links = agendaAssetMap[item.id] ?? [];
    const assetName = links[0]?.assetName ?? null;
    const isPast = (item.startDate ?? '') < today;

    let narrative: string;
    const isWarranty = /garantie|assurance|décennale/i.test(item.title);

    if (isPast && isWarranty && assetName) {
      narrative = `La garantie du **${assetName}** est terminée depuis le ${formatDateFR(item.startDate!)}. Aucune action requise.`;
    } else if (isPast && assetName) {
      narrative = `**${item.title}** (${assetName}) — terminé le ${formatDateFR(item.startDate!)}.`;
    } else if (isPast) {
      narrative = `**${item.title}** — terminé le ${formatDateFR(item.startDate!)}.`;
    } else if (assetName) {
      narrative = `**${item.title}** (${assetName}) — le ${formatDateFR(item.startDate!)}.`;
    } else {
      narrative = `**${item.title}** — le ${formatDateFR(item.startDate!)}.`;
    }

    toKnowItems.push({
      id: `toknow_${item.id}`,
      objectType: 'agenda',
      objectId: item.id,
      homeIntent: 'information',
      title: item.title,
      richText: narrative,
      iconType: 'check',
      date: item.startDate,
      badge: 'Information',
      displayStatus: isPast ? 'terminee' : 'information',
    });
  }

  // À savoir est masqué s'il n'y a rien de pertinent à afficher.

  // ── Bloc ACTIVITÉ RÉCENTE ─────────────────────────────────────────────────

  // Construire une liste unifiée (docs + exports + agenda + biens), triée par date décroissante
  type RawActivity =
    | { kind: 'doc'; ts: Date; item: typeof recentDocs[0] }
    | { kind: 'export'; ts: Date; item: typeof recentExports[0] }
    | { kind: 'agenda'; ts: Date; item: typeof recentAgenda[0] }
    | { kind: 'asset'; ts: Date; item: typeof assetRows[0] };

  const rawActivities: RawActivity[] = [
    ...recentDocs.map(d => ({ kind: 'doc' as const, ts: d.uploadedAt ? new Date(d.uploadedAt) : new Date(0), item: d })),
    ...recentExports.map(e => ({ kind: 'export' as const, ts: e.completedAt ? new Date(e.completedAt) : new Date(0), item: e })),
    ...recentAgenda.map(a => ({ kind: 'agenda' as const, ts: a.createdAt ? new Date(a.createdAt) : new Date(0), item: a })),
    ...assetRows.map(a => ({ kind: 'asset' as const, ts: a.createdAt ? new Date(a.createdAt) : new Date(0), item: a })),
  ].sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const recentActivityItems: HomeItem[] = [];

  for (const raw of rawActivities) {
    if (recentActivityItems.length >= 5) break;

    if (raw.kind === 'doc') {
      const doc = raw.item;
      const displayName = doc.retainedTitle || doc.originalFilename || 'Document';
      const typeLabel = doc.documentType ? (docTypeMap[doc.documentType] || doc.documentType) : null;
      const prefix = typeLabel && typeLabel.toUpperCase() !== 'AUTRE' ? typeLabel : 'Document';
      recentActivityItems.push({
        id: `recent_doc_${doc.id}`,
        objectType: 'document',
        objectId: doc.id,
        homeIntent: 'recent_activity',
        title: displayName,
        richText: `${prefix} **${displayName}** ajouté.`,
        timestamp: raw.ts.toISOString(),
        badge: 'Document ajouté',
        displayStatus: 'information',
      });
    } else if (raw.kind === 'export') {
      const exp = raw.item;
      const assetName = exp.assetName ?? 'Bien';
      const exportTypeLabels: Record<string, string> = {
        DOSSIER_VENTE:         'Dossier de vente',
        ASSURANCE_ESTIMATION:  'Estimation assurance',
        EXPORT_BRUT:           'Export complet',
        CIL_REGLEMENTAIRE:     'CIL - Carnet d\'Information du Logement',
        pdf_dossier:           'Dossier PDF',
      };
      const exportLabel = exportTypeLabels[exp.exportType ?? ''] ?? 'Export PDF';
      recentActivityItems.push({
        id: `recent_export_${exp.id}`,
        objectType: 'document',
        objectId: exp.assetId,
        homeIntent: 'recent_activity',
        title: assetName,
        richText: `**${exportLabel}** généré pour **${assetName}**.`,
        timestamp: raw.ts.toISOString(),
        badge: 'Export généré',
        displayStatus: 'information',
      });
    } else if (raw.kind === 'asset') {
      const ast = raw.item;
      recentActivityItems.push({
        id: `recent_asset_${ast.id}`,
        objectType: 'equipment',
        objectId: ast.id,
        homeIntent: 'recent_activity',
        title: ast.name,
        richText: `Bien **${ast.name}** créé.`,
        timestamp: raw.ts.toISOString(),
        badge: 'Bien créé',
        displayStatus: 'information',
      });
    } else {
      const ag = raw.item;
      recentActivityItems.push({
        id: `recent_agenda_${ag.id}`,
        objectType: 'agenda',
        objectId: ag.id,
        homeIntent: 'recent_activity',
        title: ag.title,
        richText: `Événement **${ag.title}** ajouté à l'agenda.`,
        timestamp: raw.ts.toISOString(),
        badge: 'Agenda',
        displayStatus: 'information',
      });
    }
  }

  // ── Bloc ENRICHISSEMENT AUTOMATIQUE ──────────────────────────────────────
  // Produit un maximum de 6 événements narratifs résumant ce que l'IA a fait seule.
  const autoEnrichmentEvents: AutoEnrichmentEvent[] = [];

  // Labels lisibles pour les clés de aiFieldUpdates
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

  // Les 5 dernières lignes d'enrichissement individuelles (une par champ modifié)
  for (const row of recentEnrichedAssets.slice(0, 5)) {
    if (!row.assetId || !row.assetName || !row.fieldKey) continue;
    const label = KC_LABELS[row.fieldKey] ?? row.fieldKey;
    autoEnrichmentEvents.push({
      id: `enrich_field_${row.assetId}_${row.fieldKey}`,
      richText: `Verebona a renseigné **${label}** sur **${row.assetName}**.`,
      assetId: row.assetId ?? undefined,
      fieldKey: row.fieldKey ?? undefined,
    });
  }

  // ── Message de situation ──────────────────────────────────────────────────
  const isEmpty = assetRows.length === 0 && agendaRows.length === 0;

  let situationStatus: SituationStatus;
  let situationMessage: string;
  let situationRichMessage: string;
  const firstTodo = visibleTodo[0] ?? null;
  const nextUpcoming = upcomingItems.find(i => i.date && i.date >= today) ?? null;

  if (isEmpty) {
    situationStatus = 'empty';
    situationMessage = 'Commencez par ajouter un bien, un document ou une date importante.';
    situationRichMessage = situationMessage;
  } else if (totalTodo > 0) {
    situationStatus = 'actions_required';
    situationMessage = totalTodo === 1
      ? '1 élément demande votre attention.'
      : `${totalTodo} éléments demandent votre attention.`;
    // Message humain enrichi
    if (totalTodo === 1 && firstTodo) {
      const ctx = firstTodo.context ? ` — **${firstTodo.context}**` : '';
      situationRichMessage = `**${firstTodo.title}**${ctx} mérite votre attention.`;
    } else if (totalTodo === 2 && firstTodo) {
      situationRichMessage = `**${totalTodo} éléments** demandent votre attention, dont **${firstTodo.title}**.`;
    } else if (firstTodo) {
      situationRichMessage = `**${totalTodo} éléments** demandent votre attention.`;
    } else {
      situationRichMessage = situationMessage;
    }
  } else if (totalUpcoming > 0) {
    situationStatus = 'all_clear';
    if (nextUpcoming?.date) {
      situationMessage = `Tout est à jour. Votre prochaine date importante est le ${formatDateFR(nextUpcoming.date)}.`;
      const titlePart = nextUpcoming.title ? ` pour **${nextUpcoming.title}**` : '';
      const ctxPart = nextUpcoming.context ? ` — ${nextUpcoming.context}` : '';
      situationRichMessage = `Tout est à jour. Votre prochaine date importante est le **${formatDateFR(nextUpcoming.date)}**${titlePart}${ctxPart}.`;
    } else {
      situationMessage = 'Tout est à jour. Vous avez des éléments à venir.';
      situationRichMessage = situationMessage;
    }
  } else {
    situationStatus = 'all_clear';
    situationMessage = 'Tout est à jour pour le moment.';
    situationRichMessage = situationMessage;
  }

  // ── Assets enrichis avec micro-signaux ───────────────────────────────────
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
      status: situationStatus,
      message: situationMessage,
      richMessage: situationRichMessage,
      todoCount: totalTodo,
      upcomingCount: totalUpcoming,
      firstTodoTitle: firstTodo?.title ?? null,
      firstTodoContext: firstTodo?.context ?? null,
      firstUpcomingTitle: nextUpcoming?.title ?? null,
      firstUpcomingDate: nextUpcoming?.date ?? null,
    },
    blocks: {
      todo: { items: visibleTodo, total: totalTodo },
      upcoming: { items: upcomingItems, total: totalUpcoming },
      toKnow: { items: toKnowItems.slice(0, 3) },
      recentActivity: { items: recentActivityItems },
      autoEnrichment: { events: autoEnrichmentEvents },
    },
    assets: {
      items: enrichedAssets,
      total: Number(totalAssetsRow[0]?.count ?? 0),
    },
    plan: planType,
  };
}
