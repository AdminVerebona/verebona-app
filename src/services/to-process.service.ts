/**
 * ToProcessService — builds the unified "À traiter" action-based view
 * CDC V2 — action families: arbitrate, attach, confirm, complete
 */
import { db } from '@/db';
import {
  assetFiles, equipments, assets,
  agendaItems,
  suppliers, supplierReviewItems,
} from '@/db/schema';
import { eq, and, or, isNull, isNotNull, ne, desc, sql, inArray } from 'drizzle-orm';
import { getAgendaAttentionItems } from '@/services/agenda/AgendaQueryService';
import { listOpenReconciliationConflicts } from '@/services/ai/reconciliation/to-process-conflicts';
import { normalizeName } from '@/services/suppliers/supplier-service';
import type {
  ToProcessItem, ToProcessFamily, ToProcessResponse, ToProcessCounters,
  Priority, ToProcessFilters,
} from '@/types/to-process';

// ─── Motif → Action mapping for documents ──────────────────────────────

interface DocumentMotifMapping {
  family: ToProcessFamily;
  reason: string;
  actionTitle: string;
  badge: string;
  priority: Priority;
  primaryAction: string;
}

function mapDocumentMotif(motif: string, doc: any): DocumentMotifMapping | null {
  const isImage = doc.mimeType?.startsWith('image/');

  switch (motif) {
    case 'missing_useful_link':
      return {
        family: 'attach',
        reason: 'missing_asset',
        actionTitle: 'Rattacher ce document à un bien',
        badge: 'Aucun bien associé',
        priority: 'medium',
        primaryAction: 'choose_asset',
      };
    case 'missing_function':
      if (isImage) return null; // images have implicit function
      return {
        family: 'complete',
        reason: 'missing_required_label',
        actionTitle: 'Renseigner le type de document',
        badge: 'Type à renseigner',
        priority: 'medium',
        primaryAction: 'fill',
      };
    case 'missing_analysis':
      return {
        family: 'confirm',
        reason: 'document_type_to_confirm',
        actionTitle: 'Confirmer le type de document',
        badge: 'Analyse en attente',
        priority: 'low',
        primaryAction: 'resolve',
      };
    case 'ai_conflict':
      return {
        family: 'arbitrate',
        reason: 'date_conflict',
        actionTitle: 'Choisir la bonne date',
        badge: 'Date incohérente',
        priority: 'high',
        primaryAction: 'choose_date',
      };
    case 'fusion_suggested':
      return null; // handled separately
    default:
      return null;
  }
}

// ─── Mapper: Document → ToProcessItem ──────────────────────────────────

function docToItem(doc: any, motifMapping: DocumentMotifMapping): ToProcessItem {
  const displayName = doc.retainedTitle?.trim() || doc.originalFilename || doc.filename;
  return {
    id: `doc_${doc.id}`,
    objectType: 'document',
    objectId: doc.id,
    family: motifMapping.family,
    reason: motifMapping.reason,
    priority: motifMapping.priority,
    actionTitle: motifMapping.actionTitle,
    objectTitle: displayName,
    badge: motifMapping.badge,
    context: {
      createdAt: doc.uploadedAt,
      documentId: doc.id,
      source: doc.lastAnalysisAt ? 'document_ai' : 'manual',
    },
    primaryAction: motifMapping.primaryAction as any,
    secondaryActions: ['view_detail', 'snooze'],
    status: 'active',
    createdAt: doc.uploadedAt,
  };
}

// ─── Mapper: Agenda item → ToProcessItem ──────────────────────────────────

function agendaFlagToFamily(flag: string): { family: ToProcessFamily; actionTitle: string; badge: string; reason: string; priority: Priority } | null {
  switch (flag) {
    case 'sans_bien':
      return {
        family: 'attach',
        actionTitle: 'Rattacher cet élément d\'agenda à un bien',
        badge: 'Aucun bien associé',
        reason: 'missing_asset',
        priority: 'medium',
      };
    case 'date_incoherente':
      return {
        family: 'arbitrate',
        actionTitle: 'Choisir la bonne date',
        badge: 'Date incohérente',
        reason: 'date_conflict',
        priority: 'high',
      };
    case 'donnee_distincte_a_qualifier':
      return {
        family: 'confirm',
        actionTitle: 'Confirmer l\'information détectée',
        badge: 'Information à confirmer',
        reason: 'asset_suggestion_to_confirm',
        priority: 'medium',
      };
    case 'en_retard':
      return null; // handled as informational, not actionable here
    default:
      return null;
  }
}

// agenda item without any date at all → À compléter
function agendaHasMissingDate(item: any): boolean {
  return !item.startDate && !item.endDate && item.attentionFlags?.length === 0;
}

function agendaToItem(item: any, flag: string): ToProcessItem | null {
  const mapping = agendaFlagToFamily(flag);
  if (!mapping) return null;

  return {
    id: `agenda_${item.id}_${flag}`,
    objectType: 'agenda',
    objectId: item.id,
    family: mapping.family,
    reason: mapping.reason,
    priority: mapping.priority,
    actionTitle: mapping.actionTitle,
    objectTitle: item.title,
    badge: mapping.badge,
    context: {
      createdAt: item.createdAt,
      assetName: item.assetLinks?.[0]?.assetName ?? undefined,
    },
    primaryAction: mapping.family === 'attach' ? 'choose_asset' : mapping.family === 'arbitrate' ? 'choose_date' : 'confirm',
    secondaryActions: ['view_detail', 'snooze'],
    status: 'active',
    createdAt: item.createdAt,
  };
}

function agendaMissingDateToItem(item: any): ToProcessItem {
  return {
    id: `agenda_${item.id}_missing_date`,
    objectType: 'agenda',
    objectId: item.id,
    family: 'complete',
    reason: 'missing_date',
    priority: 'medium',
    actionTitle: 'Ajouter une date',
    objectTitle: item.title,
    badge: 'Date manquante',
    context: {
      createdAt: item.createdAt,
      assetName: item.assetLinks?.[0]?.assetName ?? undefined,
    },
    primaryAction: 'add_date',
    secondaryActions: ['view_detail', 'snooze'],
    status: 'active',
    createdAt: item.createdAt,
  };
}

// ─── Mapper: Equipment → ToProcessItem ─────────────────────────────────

function equipmentToItem(eq: any): ToProcessItem {
  return {
    id: `equip_${eq.id}`,
    objectType: 'equipment',
    objectId: eq.id,
    family: 'attach',
    reason: 'missing_asset',
    priority: 'medium',
    actionTitle: 'Rattacher cet équipement à un bien',
    objectTitle: eq.name,
    badge: 'Aucun bien associé',
    context: {
      createdAt: eq.createdAt,
    },
    primaryAction: 'choose_asset',
    secondaryActions: ['view_detail', 'snooze'],
    status: 'active',
    createdAt: eq.createdAt,
  };
}

// ─── Mapper: Supplier review → ToProcessItem ───────────────────────────

function supplierReviewToItem(item: any): ToProcessItem | null {
  const isDedup = item.itemType === 'deduplication';
  const isContactConflict = item.itemType === 'contact_conflict';

  if (isDedup) {
    return {
      id: `supplier_review_${item.id}`,
      objectType: 'supplier',
      objectId: item.id,
      family: 'confirm',
      reason: 'supplier_to_confirm',
      priority: 'medium',
      actionTitle: 'Confirmer le fournisseur détecté',
      objectTitle: item.detectedName ?? 'Fournisseur inconnu',
      badge: 'Fournisseur à confirmer',
      context: {
        createdAt: item.createdAt,
        suggestedSupplierLabel: item.detectedName ?? undefined,
        suggestedSupplierId: item.supplierId?.toString(),
        documentId: item.documentId,
        documentFilename: item.documentFilename,
        candidateSupplierIds: item.candidateSupplierIds,
      },
      primaryAction: 'confirm',
      secondaryActions: ['view_detail', 'snooze'],
      status: 'active',
      createdAt: item.createdAt,
    };
  }

  if (isContactConflict) {
    const isIban = item.conflictingField === 'iban';
    return {
      id: `supplier_review_${item.id}`,
      objectType: 'supplier',
      objectId: item.id,
      family: 'arbitrate',
      reason: 'supplier_conflict',
      priority: 'high',
      actionTitle: isIban ? 'Choisir les coordonnées à conserver' : `Choisir la bonne valeur — ${item.conflictingField ?? 'donnée'}`,
      objectTitle: item.supplierName ?? 'Fournisseur',
      badge: isIban ? 'Coordonnées contradictoires' : `${item.conflictingField ?? 'Donnée'} contradictoire`,
      context: {
        createdAt: item.createdAt,
        currentValue: item.currentValue,
        detectedValue: item.detectedValue,
        conflictingField: item.conflictingField,
        supplierId: item.supplierId,
        documentId: item.documentId,
        documentFilename: item.documentFilename,
        conflictingValues: [
          { label: 'Actuel', value: item.currentValue ?? '—' },
          { label: 'Détecté', value: item.detectedValue ?? '—' },
        ],
      },
      primaryAction: 'resolve',
      secondaryActions: ['view_detail', 'snooze'],
      status: 'active',
      createdAt: item.createdAt,
    };
  }

  return null;
}

// ─── Main service ──────────────────────────────────────────────────────

export async function getToProcessItems(
  accountId: number,
  filters: ToProcessFilters = {}
): Promise<ToProcessResponse> {
  const { family, objectType, priority, status: filterStatus } = filters;

  // ── Fetch all raw data in parallel ───────────────────────────────────
  const [documentsRaw, agendaAttentionItems, equipementsSansBien, supplierReviewRows, assetRows] = await Promise.all([
    // Documents
    db.select({
      id: assetFiles.id,
      publicId: assetFiles.publicId,
      filename: assetFiles.filename,
      originalFilename: assetFiles.originalFilename,
      mimeType: assetFiles.mimeType,
      retainedTitle: assetFiles.retainedTitle,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      assetId: assetFiles.assetId,
      linkedAssetId: assetFiles.linkedAssetId,
      linkedRoomId: assetFiles.linkedRoomId,
      equipmentId: assetFiles.equipmentId,
      documentType: assetFiles.documentType,
      documentDate: assetFiles.documentDate,
      supplier: assetFiles.supplier,
      description: assetFiles.description,
      uploadedAt: assetFiles.uploadedAt,
      lastAnalysisAt: assetFiles.lastAnalysisAt,
      analysisState: assetFiles.analysisState,
    })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt),
          eq(assetFiles.isWebLink, false),
          eq(assetFiles.isIgnored, false),
          ne(assetFiles.analysisState, 'ANALYZING'),
          or(
            and(
              isNull(assetFiles.assetId),
              isNull(assetFiles.linkedAssetId),
              isNull(assetFiles.linkedRoomId),
              isNull(assetFiles.equipmentId)
            ),
            eq(assetFiles.analysisState, 'CONFLICT_DETECTED'),
            eq(assetFiles.analysisState, 'FUSION_SUGGESTED'),
          )
        )
      )
      .orderBy(desc(assetFiles.uploadedAt)),

    // Agenda
    getAgendaAttentionItems(accountId),

    // Équipements sans bien
    db.select({
      id: equipments.id,
      name: equipments.name,
      type: equipments.type,
      category: equipments.category,
      assetId: equipments.assetId,
      status: equipments.status,
    })
      .from(equipments)
      .innerJoin(assets, eq(equipments.assetId, assets.id))
      .where(
        and(
          eq(assets.accountId, accountId),
          isNull(equipments.archivedAt),
          isNotNull(assets.deletedAt),
        )
      ),

    // Supplier review items
    db.select({
      id: supplierReviewItems.id,
      itemType: supplierReviewItems.itemType,
      status: supplierReviewItems.status,
      detectedName: supplierReviewItems.detectedName,
      conflictingField: supplierReviewItems.conflictingField,
      currentValue: supplierReviewItems.currentValue,
      detectedValue: supplierReviewItems.detectedValue,
      supplierId: supplierReviewItems.supplierId,
      supplierName: suppliers.name,
      supplierNormalizedName: suppliers.normalizedName,
      documentId: supplierReviewItems.documentId,
      documentFilename: assetFiles.originalFilename,
      candidateSupplierIds: supplierReviewItems.candidateSupplierIds,
      createdAt: supplierReviewItems.createdAt,
    })
      .from(supplierReviewItems)
      .leftJoin(suppliers, eq(suppliers.id, supplierReviewItems.supplierId))
      .leftJoin(assetFiles, eq(assetFiles.id, supplierReviewItems.documentId))
      .where(and(
        eq(supplierReviewItems.accountId, accountId),
        eq(supplierReviewItems.status, 'open'),
      ))
      .limit(100),

    // Assets with coherence alerts
    db.select({
      id: assets.id,
      name: assets.name,
      keyCharacteristics: assets.keyCharacteristics,
    })
      .from(assets)
      .where(and(
        eq(assets.accountId, accountId),
        isNull(assets.deletedAt),
      )),
  ]);

  // ── Build items ──────────────────────────────────────────────────────

  const items: ToProcessItem[] = [];

  // Documents
  const isImage = (mimeType: string | null) => !!mimeType?.startsWith('image/');

  for (const doc of documentsRaw) {
    const motifs: { motif: string; mapping: DocumentMotifMapping | null }[] = [];

    if (doc.analysisState === 'FUSION_SUGGESTED') {
      motifs.push({ motif: 'fusion_suggested', mapping: null });
      continue; // Skip fusion items for now
    }

    if (!doc.assetId && !doc.linkedAssetId && !doc.linkedRoomId && !doc.equipmentId) {
      motifs.push({ motif: 'missing_useful_link', mapping: mapDocumentMotif('missing_useful_link', doc) });
    }
    if (doc.analysisState === 'CONFLICT_DETECTED') {
      motifs.push({ motif: 'ai_conflict', mapping: mapDocumentMotif('ai_conflict', doc) });
    }

    for (const { mapping } of motifs) {
      if (mapping) {
        items.push(docToItem(doc, mapping));
      }
    }
  }

  // Agenda
  for (const agItem of agendaAttentionItems) {
    // Check for missing date first
    if (agendaHasMissingDate(agItem)) {
      items.push(agendaMissingDateToItem(agItem));
    }

    // Map attention flags
    if (agItem.attentionFlags?.length > 0) {
      for (const flag of agItem.attentionFlags) {
        const mapped = agendaToItem(agItem, flag);
        if (mapped) items.push(mapped);
      }
    }
  }

  // ── Détection de proximité temporelle (même bien, dates proches) ─────
  // Ex : "Fin contrat gardiennage pneus" le 20 juin et "Changement pneus"
  // le 24 juin sur la même voiture → lien probable
  const PROXIMITY_WINDOW_DAYS = 7;
  const assetAgendaMap = new Map<number, { item: any; date: string; title: string; assetName?: string }[]>();

  for (const agItem of agendaAttentionItems) {
    if (!agItem.startDate) continue;
    for (const link of agItem.assetLinks || []) {
      if (!link.assetId) continue;
      if (!assetAgendaMap.has(link.assetId)) {
        assetAgendaMap.set(link.assetId, []);
      }
      assetAgendaMap.get(link.assetId)!.push({
        item: agItem,
        date: agItem.startDate,
        title: agItem.title,
        assetName: link.assetName,
      });
    }
  }

  for (const [, agItems] of assetAgendaMap) {
    if (agItems.length < 2) continue;
    agItems.sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 0; i < agItems.length - 1; i++) {
      const curr = agItems[i];
      const next = agItems[i + 1];
      const currDate = new Date(curr.date + 'T12:00:00');
      const nextDate = new Date(next.date + 'T12:00:00');
      const diffDays = Math.round((nextDate.getTime() - currDate.getTime()) / 86400000);

      if (diffDays > 0 && diffDays <= PROXIMITY_WINDOW_DAYS) {
        const assetNamePart = curr.assetName ? ` (${curr.assetName})` : '';
        items.push({
          id: `agenda_proximity_${curr.item.id}_${next.item.id}`,
          objectType: 'agenda' as const,
          objectId: curr.item.id,
          family: 'arbitrate' as const,
          reason: 'date_conflict',
          priority: 'medium' as const,
          actionTitle: `${curr.title} puis ${next.title} à ${diffDays} jour${diffDays > 1 ? 's' : ''} d'intervalle${assetNamePart}`,
          objectTitle: `${curr.title} → ${next.title}`,
          badge: 'Échéances proches',
          context: {
            conflictingValues: [
              { label: curr.title, value: curr.date },
              { label: next.title, value: next.date },
            ],
            conflictingField: 'startDate',
            assetName: curr.assetName,
          },
          primaryAction: 'resolve' as const,
          secondaryActions: ['view_detail' as const, 'snooze' as const],
          status: 'active' as const,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // ── Conflits de réconciliation — CDC §4.2.9, critère d'acceptation n°13 ──
  // « Les contradictions non résolues alimentent la page À traiter, catégorie
  //   À arbitrer. » Sans cette lecture, le moteur de réconciliation écrit ses
  // conflits en base sans que personne ne les voie jamais.
  //
  // Aucun test de drapeau : la table est vide tant que la réconciliation n'a
  // rien écrit, et le jour de la bascule la page se remplit d'elle-même.
  items.push(...(await listOpenReconciliationConflicts(accountId)));

  // Équipements
  for (const eq of equipementsSansBien) {
    items.push(equipmentToItem(eq));
  }

  // Supplier reviews — group contact conflicts by supplier, keep dedups individual
  const dedupRows = supplierReviewRows.filter(sr => sr.itemType === 'deduplication');
  const contactConflictRows = supplierReviewRows.filter(sr => sr.itemType === 'contact_conflict');

  // Individual deduplication items — skip stale ones where name matches exactly
  for (const sr of dedupRows) {
    // If supplier name and detected name already match, the dedup is no longer relevant
    if (sr.supplierNormalizedName && sr.detectedName &&
        normalizeName(sr.detectedName) === sr.supplierNormalizedName) {
      continue;
    }
    const mapped = supplierReviewToItem(sr);
    if (mapped) items.push(mapped);
  }

  // Grouped contact conflict items (one card per supplier)
  const conflictGroups: Map<number | string, typeof contactConflictRows> = new Map();
  for (const sr of contactConflictRows) {
    const key = sr.supplierId ?? `_no_supplier_${sr.id}`;
    if (!conflictGroups.has(key)) conflictGroups.set(key, []);
    conflictGroups.get(key)!.push(sr);
  }

  for (const [, group] of conflictGroups) {
    const first = group[0];
    const conflictCount = group.length;
    const fieldLabels: Record<string, string> = {
      email: 'Email', phone: 'Téléphone', address: 'Adresse',
      addressLine1: 'Adresse (ligne 1)', addressLine2: 'Adresse (ligne 2)',
      postalCode: 'Code postal', city: 'Ville', country: 'Pays',
      iban: 'IBAN', siret: 'SIRET', name: 'Nom',
      website: 'Site web', ibanHolderName: 'Titulaire IBAN',
    };

    const conflictingValues = group.map(sr => ({
      label: fieldLabels[sr.conflictingField ?? ''] ?? sr.conflictingField ?? 'Champ',
      value: `Actuel: ${sr.currentValue || '—'} / Détecté: ${sr.detectedValue || '—'}`,
    }));

    // Skip if no field has any actual value to show (all empty strings)
    const hasRealConflict = group.some(
      sr => sr.currentValue?.trim() || sr.detectedValue?.trim()
    );
    if (!hasRealConflict && conflictCount > 0) continue;

    const hasIban = group.some(sr => sr.conflictingField === 'iban');
    const fieldsList = group
      .map(sr => fieldLabels[sr.conflictingField ?? ''] ?? sr.conflictingField)
      .filter(Boolean)
      .join(', ');

    items.push({
      id: `supplier_group_${first.supplierId ?? first.id}`,
      objectType: 'supplier',
      objectId: first.supplierId ?? first.id,
      family: 'arbitrate',
      reason: 'supplier_conflict',
      priority: 'high',
      actionTitle: hasIban
        ? 'Choisir les coordonnées à conserver'
        : `Choisir les bonnes valeurs — ${fieldsList}`,
      objectTitle: first.supplierName ?? 'Fournisseur',
      badge: `${conflictCount} donnée${conflictCount > 1 ? 's' : ''} contradictoire${conflictCount > 1 ? 's' : ''}`,
      context: {
        createdAt: first.createdAt?.toISOString(),
        conflictingValues,
        conflictingField: fieldsList,
        supplierId: first.supplierId ?? undefined,
        documentId: first.documentId ?? undefined,
        documentFilename: first.documentFilename ?? undefined,
      },
      primaryAction: 'resolve',
      secondaryActions: ['view_detail', 'snooze'],
      status: 'active',
      createdAt: first.createdAt?.toISOString(),
    });
  }

  // ── Coherence alerts (assets with AI-detected inconsistencies) ─────
  const coherenceFieldLabels: Record<string, string> = {
    acquisitionPrice: 'prix d\'acquisition', mileage: 'kilométrage',
    livingArea: 'surface habitable', constructionYear: 'année de construction',
    occupancyStatus: 'statut d\'occupation', monthlyRent: 'loyer',
    estimatedValue: 'valeur estimée', address1: 'adresse',
  };

  for (const asset of assetRows) {
    let alerts: { field: string; section?: string; issue: string; suggestedValue?: string | null; label?: string; aiValue?: string; currentValue?: string }[] = [];
    let dismissedFields: string[] = [];
    try {
      const kc = typeof asset.keyCharacteristics === 'string'
        ? JSON.parse(asset.keyCharacteristics)
        : asset.keyCharacteristics ?? {};
      alerts = (kc as any).coherenceAlerts ?? [];
      dismissedFields = Array.isArray((kc as any).dismissedCoherenceAlerts)
        ? (kc as any).dismissedCoherenceAlerts
        : [];
    } catch { /* ignore parse error */ }

    const dismissedSet = new Set(dismissedFields);
    const validAlerts = alerts.filter(a => a.field && a.issue && !dismissedSet.has(a.field));
    if (validAlerts.length === 0) continue;

    const conflictingValues = validAlerts.map(a => ({
      label: coherenceFieldLabels[a.field] ?? a.field,
      value: a.aiValue ?? a.suggestedValue ?? a.issue,
    }));

    items.push({
      id: `coherence_${asset.id}`,
      objectType: 'asset',
      objectId: asset.id,
      family: 'arbitrate',
      reason: 'data_inconsistency',
      priority: 'high',
      actionTitle: `Incohérence détectée — ${asset.name}`,
      objectTitle: `${validAlerts.length} alerte${validAlerts.length > 1 ? 's' : ''}`,
      badge: 'Incohérence',
      context: {
        conflictingValues,
        conflictingField: validAlerts[0].field,
        currentValue: validAlerts[0].currentValue,
        detectedValue: (validAlerts[0].aiValue ?? validAlerts[0].suggestedValue) ?? undefined,
        assetName: asset.name,
      },
      primaryAction: 'resolve',
      secondaryActions: ['view_detail', 'snooze'],
      status: 'active',
      createdAt: new Date().toISOString(),
    });
  }

  // ── Apply filters ────────────────────────────────────────────────────

  let filtered = items;

  if (family) {
    filtered = filtered.filter(i => i.family === family);
  }
  if (objectType) {
    filtered = filtered.filter(i => i.objectType === objectType);
  }
  if (priority) {
    filtered = filtered.filter(i => i.priority === priority);
  }
  if (filterStatus) {
    filtered = filtered.filter(i => i.status === filterStatus);
  }

  // ── Sort ─────────────────────────────────────────────────────────────
  const priorityOrder: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  const familyOrder: Record<ToProcessFamily, number> = { arbitrate: 0, confirm: 1, attach: 2, complete: 3 };

  filtered.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    const fa = familyOrder[a.family] ?? 3;
    const fb = familyOrder[b.family] ?? 3;
    if (fa !== fb) return fa - fb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // ── Counters ─────────────────────────────────────────────────────────
  const counters: ToProcessCounters = {
    arbitrate: items.filter(i => i.family === 'arbitrate').length,
    attach: items.filter(i => i.family === 'attach').length,
    confirm: items.filter(i => i.family === 'confirm').length,
    complete: items.filter(i => i.family === 'complete').length,
    priority: items.filter(i => i.priority === 'high').length,
  };

  return {
    total: filtered.length,
    counters,
    items: filtered,
  };
}

/**
 * Resolve a to-process item
 */
export async function resolveToProcessItem(
  accountId: number,
  userId: number,
  itemId: string,
  resolution: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean }> {
  // For now, delegate to existing supplier resolve logic
  if (itemId.startsWith('supplier_review_')) {
    const reviewId = parseInt(itemId.replace('supplier_review_', ''), 10);
    if (isNaN(reviewId)) throw new Error('Invalid review item id');

    // We'll keep the legacy endpoint for supplier resolution
    return { success: true };
  }

  // For simple actions, we update the relevant DB tables
  // Document attach
  if (itemId.startsWith('doc_') && resolution === 'attach_asset' && payload.assetId) {
    const docId = parseInt(itemId.replace('doc_', ''), 10);
    await db.update(assetFiles)
      .set({ assetId: parseInt(payload.assetId as string, 10), updatedAt: new Date() })
      .where(and(eq(assetFiles.id, docId), eq(assetFiles.accountId, accountId)));
    return { success: true };
  }

  // Document ignore (snooze)
  if (itemId.startsWith('doc_') && resolution === 'snooze') {
    const docId = parseInt(itemId.replace('doc_', ''), 10);
    await db.update(assetFiles)
      .set({ isIgnored: true, updatedAt: new Date() })
      .where(and(eq(assetFiles.id, docId), eq(assetFiles.accountId, accountId)));
    return { success: true };
  }

  throw new Error(`Unsupported resolution: ${resolution} for ${itemId}`);
}

/**
 * Snooze (mettre de côté) an item by type
 */
export async function snoozeItem(accountId: number, itemId: string): Promise<void> {
  if (itemId.startsWith('doc_')) {
    const docId = parseInt(itemId.replace('doc_', ''), 10);
    if (isNaN(docId)) throw new Error('Invalid document id');
    await db.update(assetFiles)
      .set({ isIgnored: true, updatedAt: new Date() })
      .where(and(eq(assetFiles.id, docId), eq(assetFiles.accountId, accountId)));
    return;
  }

  // Coherence alert snooze → dismiss the first field
  if (itemId.startsWith('coherence_')) {
    const assetId = parseInt(itemId.replace('coherence_', ''), 10);
    if (isNaN(assetId)) throw new Error('Invalid asset id');

    const [asset] = await db
      .select({ keyCharacteristics: assets.keyCharacteristics })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId)))
      .limit(1);

    if (asset) {
      const kc = typeof asset.keyCharacteristics === 'string'
        ? JSON.parse(asset.keyCharacteristics)
        : (asset.keyCharacteristics ?? {});
      const alerts: { field: string }[] = (kc as any).coherenceAlerts ?? [];
      const dismissed: string[] = Array.isArray((kc as any).dismissedCoherenceAlerts)
        ? (kc as any).dismissedCoherenceAlerts
        : [];
      const firstUndealt = alerts.find((a: { field: string }) => !dismissed.includes(a.field));
      if (firstUndealt && !dismissed.includes(firstUndealt.field)) {
        dismissed.push(firstUndealt.field);
        await db.update(assets)
          .set({
            keyCharacteristics: sql`jsonb_set(
              COALESCE(key_characteristics::jsonb, '{}'::jsonb),
              '{dismissedCoherenceAlerts}',
              ${JSON.stringify(dismissed)}::jsonb
            )`,
            updatedAt: new Date(),
          })
          .where(eq(assets.id, assetId));
      }
    }
    return;
  }

  if (itemId.startsWith('agenda_')) {
    const parts = itemId.split('_');
    if (parts.length < 2) throw new Error('Invalid agenda item id');
    const agendaId = parseInt(parts[1], 10);
    if (isNaN(agendaId)) throw new Error('Invalid agenda id');
    // For agenda items, mark as ignored
    await db.update(agendaItems)
      .set({ updatedAt: new Date() })
      .where(and(eq(agendaItems.id, agendaId), eq(agendaItems.accountId, accountId)));
    return;
  }

  if (itemId.startsWith('equip_')) {
    const equipId = parseInt(itemId.replace('equip_', ''), 10);
    if (isNaN(equipId)) throw new Error('Invalid equipment id');
    await db.update(equipments)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(equipments.id, equipId),
        inArray(equipments.assetId, db.select({ id: assets.id }).from(assets).where(eq(assets.accountId, accountId)))
      ));
    return;
  }

  if (itemId.startsWith('supplier_review_')) {
    const reviewId = parseInt(itemId.replace('supplier_review_', ''), 10);
    if (isNaN(reviewId)) throw new Error('Invalid review id');
    await db.update(supplierReviewItems)
      .set({ status: 'resolved', resolution: 'ignored', updatedAt: new Date() })
      .where(and(eq(supplierReviewItems.id, reviewId), eq(supplierReviewItems.accountId, accountId)));
    return;
  }

  throw new Error(`Unsupported snooze for: ${itemId}`);
}

/**
 * Unsnooze (réactiver) an item by type
 */
export async function unsnoozeItem(accountId: number, itemId: string): Promise<void> {
  if (itemId.startsWith('doc_')) {
    const docId = parseInt(itemId.replace('doc_', ''), 10);
    if (isNaN(docId)) throw new Error('Invalid document id');
    await db.update(assetFiles)
      .set({ isIgnored: false, updatedAt: new Date() })
      .where(and(eq(assetFiles.id, docId), eq(assetFiles.accountId, accountId)));
    return;
  }

  if (itemId.startsWith('equip_')) {
    const equipId = parseInt(itemId.replace('equip_', ''), 10);
    if (isNaN(equipId)) throw new Error('Invalid equipment id');
    await db.update(equipments)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(
        eq(equipments.id, equipId),
        inArray(equipments.assetId, db.select({ id: assets.id }).from(assets).where(eq(assets.accountId, accountId)))
      ));
    return;
  }

  throw new Error(`Unsupported unsnooze for: ${itemId}`);
}