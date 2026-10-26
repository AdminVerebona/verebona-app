/**
 * equipment-auto-link.service.ts
 * Lie automatiquement les documents, événements agenda et fournisseurs
 * d'un bien à un équipement spécifique.
 *
 * Stratégie (CDC V2 §12.3) :
 *   1. Matching déterministe d'abord (nom équipement dans titre/doc/fournisseur).
 *   2. IA uniquement si plusieurs candidats possibles, aucun match clair,
 *      ou rattachement incertain.
 *
 * L'analyse documentaire principale (gemini-client.ts) doit produire
 * des `equipment_candidates` pour éviter les appels IA redondants.
 *
 * Lot 49 (SEC-04) : l'équipement est chargé PAR SON COMPTE (bien porteur),
 * les candidats (documents, agenda, fournisseurs) sont lus dans le compte,
 * et chaque écriture porte la condition de compte dans son SQL — aucune
 * liaison intercomptes, même si une relation incorrecte existe en base.
 */

// CDC §12 critère n°4 : plus aucun accès direct au SDK. Les deux départages
// modèles de ce service passent par l'opération `reconcile_links` de la
// gateway (usage 2), qui porte le modèle, le prompt versionné, le schéma de
// sortie, le coût et l'idempotence.
import { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS } from '@/services/ai/reconciliation/link-reconciler';
import type { LinkAmbiguity } from '@/services/ai/reconciliation/master/link-ambiguity';
import { proposeDocumentEquipmentLink } from '@/services/to-process/document-equipment-link';
import { db } from '@/db';
import {
  equipments, assets, assetFiles, agendaItems, agendaAssetLinks, agendaEquipmentLinks,
  suppliers, assetSuppliers, equipmentSuppliers, documentSuppliers,
} from '@/db/schema';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { ownedSql } from '@/services/security/account-ownership';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AutoLinkResult {
  documents: { id: number; score: number; reason: string }[];
  agendaItems: { id: number; score: number; reason: string }[];
  suppliers: { id: number; score: number; reason: string }[];
  applied: {
    documentsLinked: number;
    agendaLinked: number;
    suppliersLinked: number;
  };
  /** Lot 75G : résultat du service commun (sens EQUIPMENT_DOCUMENT). */
  documentSync?: import('./document-equipment-link.service').EquipmentDocumentResult;
}

interface CandidateAgenda {
  id: number;
  title: string;
  startDate: string | null;
  description: string | null;
  manualStatus: string | null;
}

interface CandidateSupplier {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

// ── Ambiguïtés de rattachement (CDC 15 T3-07, architecture T3 `master`) ─────

/**
 * Abstentions explicites du départage T3 (marge insuffisante, égalité,
 * identifiant hors liste) : aucun rattachement automatique n'est fait pour
 * ces candidats, et chacune est journalisée.
 *
 * Document → équipement (`document` fourni, section `matches`) : une marge
 * insuffisante ou une égalité devient en plus une carte « À traiter »
 * `LINK-ELT` (`proposeDocumentEquipmentLink`, idempotente, résoluble et
 * annulable), avec les équipements en concurrence — tous au-dessus du seuil.
 * Équipement → objets : journal seul (relations non exclusives, arbitrage
 * lead). Un échec de proposition ne bloque jamais le rattachement.
 *
 * Renvoie le nombre d'ambiguïtés traitées.
 */
export async function reportLinkAmbiguities(
  context: { accountId: number; subject: string; document?: { fileId: number; assetId: number } },
  ambiguities: LinkAmbiguity[] | undefined,
): Promise<number> {
  for (const a of ambiguities ?? []) {
    console.warn(
      `[equipment-auto-link] rattachement ambigu, aucune liaison automatique — ${context.subject} `
      + `(compte ${context.accountId}) : ${a.section} ${a.reasonCode} candidats [${a.candidateIds.join(', ')}]`,
    );
    if (!context.document || a.section !== 'matches' || !a.candidates || a.candidates.length < 2) continue;
    try {
      const r = await proposeDocumentEquipmentLink({
        accountId: context.accountId,
        fileId: context.document.fileId,
        assetId: context.document.assetId,
        candidates: a.candidates.map((c) => ({ equipmentId: c.candidateId, score: c.score, reason: c.reason })),
      });
      if (r.status === 'SKIPPED' || r.rejected.length > 0) {
        console.warn(`[equipment-auto-link] proposition LINK-ELT ${r.status} — ${r.reason}`
          + (r.rejected.length > 0 ? ` (rejetés : ${r.rejected.join(', ')})` : ''));
      }
    } catch (e) {
      console.error('[equipment-auto-link] proposition LINK-ELT impossible (non bloquant) :', (e as Error).message);
    }
  }
  return ambiguities?.length ?? 0;
}

// ── Deterministic matcher ───────────────────────────────────────────────────

const DETERMINISTIC_THRESHOLD = 0.7;  // score pour appliquer sans IA
const AMBIGUOUS_THRESHOLD = 0.3;      // score pour envoyer à l'IA

/**
 * Tokenize une chaîne en mots-clés significatifs (minuscules, sans accents approchés).
 */
function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\u00e0-\u00fc\s-]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1 && !['le', 'la', 'les', 'des', 'du', 'de', 'un', 'une', 'et', 'ou', 'a', 'au', 'aux'].includes(t))
  );
}

/**
 * Dice coefficient entre deux sets de tokens.
 */
function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return (2 * intersection) / (a.size + b.size);
}

/**
 * Match déterministe : compare le nom/type de l'équipement avec les métadonnées
 * d'un document, agenda ou fournisseur.
 *
 * Retourne le score de pertinence (0.0 à 1.0) et une raison.
 */
function deterministicMatch(
  equipmentName: string,
  equipmentType: string | null,
  target: { title?: string | null; supplier?: string | null; description?: string | null },
): { score: number; reason: string } {
  const equipTokens = tokens(`${equipmentName} ${equipmentType ?? ''}`);

  // Collect all text from the target
  const targetText = [target.title, target.supplier, target.description]
    .filter(Boolean)
    .join(' ');
  const targetTokens = tokens(targetText);

  if (targetTokens.size === 0) return { score: 0, reason: 'Aucune information disponible' };

  // Exact match on equipment name in title → high confidence
  const nameLower = equipmentName.toLowerCase();
  const titleLower = (target.title ?? '').toLowerCase();
  if (titleLower.includes(nameLower)) {
    return { score: 0.95, reason: `Nom de l'équipement "${equipmentName}" trouvé dans le titre` };
  }

  // Supplier match
  const supplierLower = (target.supplier ?? '').toLowerCase();
  if (supplierLower.includes(nameLower)) {
    return { score: 0.85, reason: `Nom de l'équipement "${equipmentName}" trouvé chez le fournisseur` };
  }

  // Token similarity
  const sim = tokenSimilarity(equipTokens, targetTokens);
  if (sim >= DETERMINISTIC_THRESHOLD) {
    return { score: 0.8, reason: `Fortes similitudes lexicales avec "${equipmentName}" (${Math.round(sim * 100)}%)` };
  }

  // Partial match in description
  const descLower = (target.description ?? '').toLowerCase();
  if (descLower.includes(nameLower)) {
    return { score: 0.6, reason: `Équipement "${equipmentName}" mentionné dans la description` };
  }

  if (sim >= AMBIGUOUS_THRESHOLD) {
    return { score: 0.4, reason: `Faibles similitudes lexicales avec "${equipmentName}" (${Math.round(sim * 100)}%)` };
  }

  return { score: 0, reason: 'Aucune correspondance trouvée' };
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildAgendaList(items: CandidateAgenda[]): string {
  if (items.length === 0) return 'Aucun événement agenda disponible.';
  return items.map(i => {
    const parts = [`[id:${i.id}] "${i.title}"`];
    if (i.startDate) parts.push(`date:${i.startDate}`);
    if (i.manualStatus) parts.push(`statut:${i.manualStatus}`);
    if (i.description) parts.push(`— ${i.description.slice(0, 100)}`);
    return parts.join(' | ');
  }).join('\n');
}

function buildSuppliersList(sups: CandidateSupplier[]): string {
  if (sups.length === 0) return 'Aucun fournisseur disponible.';
  return sups.map(s => {
    const parts = [`[id:${s.id}] "${s.name}"`];
    if (s.email) parts.push(`email:${s.email}`);
    if (s.phone) parts.push(`tél:${s.phone}`);
    return parts.join(' | ');
  }).join('\n');
}

// ── Deterministic resolution ────────────────────────────────────────────────

/**
 * Applique le matching déterministe sur tous les candidats.
 * Retourne les matchs clairs (score ≥ seuil) et les ambigus (score ≥ seuil_bas).
 */
function resolveDeterministically(
  equipmentName: string,
  equipmentType: string | null,
  candidateAgenda: CandidateAgenda[],
  candidateSuppliers: CandidateSupplier[],
): {
  clear: { agendaItems: AutoLinkResult['agendaItems']; suppliers: AutoLinkResult['suppliers'] };
  ambiguous: { agendaItems: CandidateAgenda[]; suppliers: CandidateSupplier[] };
} {
  const clearAgenda: AutoLinkResult['agendaItems'] = [];
  const ambiguousAgenda: CandidateAgenda[] = [];

  for (const item of candidateAgenda) {
    const { score, reason } = deterministicMatch(equipmentName, equipmentType, {
      title: item.title,
      description: item.description,
    });
    if (score >= DETERMINISTIC_THRESHOLD) {
      clearAgenda.push({ id: item.id, score, reason });
    } else if (score >= AMBIGUOUS_THRESHOLD) {
      ambiguousAgenda.push(item);
    }
  }

  const clearSuppliers: AutoLinkResult['suppliers'] = [];
  const ambiguousSuppliers: CandidateSupplier[] = [];

  for (const sup of candidateSuppliers) {
    const { score, reason } = deterministicMatch(equipmentName, equipmentType, {
      title: sup.name,
      supplier: sup.name,
    });
    if (score >= DETERMINISTIC_THRESHOLD) {
      clearSuppliers.push({ id: sup.id, score, reason });
    } else if (score >= AMBIGUOUS_THRESHOLD) {
      ambiguousSuppliers.push(sup);
    }
  }

  return {
    clear: { agendaItems: clearAgenda, suppliers: clearSuppliers },
    ambiguous: { agendaItems: ambiguousAgenda, suppliers: ambiguousSuppliers },
  };
}

// ── Main service ──────────────────────────────────────────────────────────────

export async function runEquipmentAutoLink(
  equipmentId: number,
  accountId: number,
  opts: { guard?: { assertActive(what: string): Promise<void> } } = {},
): Promise<AutoLinkResult> {
  // 1. Load equipment info
  const [equip] = await db
    .select({
      id: equipments.id,
      name: equipments.name,
      type: equipments.type,
      assetId: equipments.assetId,
      substructureId: equipments.substructureId,
    })
    .from(equipments)
    .innerJoin(assets, and(eq(assets.id, equipments.assetId), eq(assets.accountId, accountId)))
    .where(eq(equipments.id, equipmentId))
    .limit(1);

  // Équipement d'un autre compte : traité comme introuvable (aucune lecture).
  if (!equip) throw new Error('Equipment not found');

  const assetId = equip.assetId;

  // 2-3. Documents (lot 71A, parcours EQUIPMENT_DOCUMENT) : service commun —
  // chaque document du bien (tous, par pages) est rapproché parmi TOUS les
  // équipements du bien (jamais repris à un équipement similaire), T3
  // seulement pour les vraies ambiguïtés, avec le contexte enrichi ; lot 75G :
  // l'ancienne liste lexicale et son écriture directe de
  // `asset_files.equipment_id` sont supprimées ; abstention → carte LINK-ELT.
  const { syncEquipmentDocumentLinks } = await import('./document-equipment-link.service');
  const { loadEquipmentProfiles } = await import('./document-equipment-link.service');
  const { formatEquipmentSubject } = await import('./document-equipment-matching');
  const docs = await syncEquipmentDocumentLinks({ accountId, equipmentId, allowAi: true, proposeCards: true, guard: opts.guard });
  const profils = await loadEquipmentProfiles(accountId, { assetIds: [assetId] });
  const profil = profils.find((p) => p.id === equipmentId);

  // 4. Get candidate agenda items (NOT yet linked)
  const alreadyLinkedAgenda = await db
    .select({ agendaItemId: agendaEquipmentLinks.agendaItemId })
    .from(agendaEquipmentLinks)
    .where(eq(agendaEquipmentLinks.equipmentId, equipmentId));
  const linkedAgendaIds = alreadyLinkedAgenda.map(r => r.agendaItemId);

  let candidateAgendaItems: CandidateAgenda[] = [];
  const assetAgendaLinks_ = await db
    .select({ agendaItemId: agendaAssetLinks.agendaItemId })
    .from(agendaAssetLinks)
    .where(eq(agendaAssetLinks.assetId, assetId));
  const assetAgendaIds = assetAgendaLinks_.map(r => r.agendaItemId);

  if (assetAgendaIds.length > 0) {
    const agendaRows = await db
      .select({
        id: agendaItems.id,
        title: agendaItems.title,
        startDate: agendaItems.startDate,
        description: agendaItems.description,
        manualStatus: agendaItems.manualStatus,
      })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        inArray(agendaItems.id, assetAgendaIds),
      ));
    candidateAgendaItems = linkedAgendaIds.length > 0
      ? agendaRows.filter(i => !linkedAgendaIds.includes(i.id))
      : agendaRows;
  }

  // 5. Get candidate suppliers (NOT yet linked)
  const alreadyLinkedSuppliers = await db
    .select({ supplierId: equipmentSuppliers.supplierId })
    .from(equipmentSuppliers)
    .where(eq(equipmentSuppliers.equipmentId, equipmentId));
  const linkedSupplierIds = alreadyLinkedSuppliers.map(r => r.supplierId);

  const assetSupplierRows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      phone: suppliers.phone,
    })
    .from(assetSuppliers)
    .innerJoin(suppliers, and(eq(suppliers.id, assetSuppliers.supplierId), eq(suppliers.accountId, accountId)))
    .where(eq(assetSuppliers.assetId, assetId));

  const candidateSuppliers = linkedSupplierIds.length > 0
    ? assetSupplierRows.filter(s => !linkedSupplierIds.includes(s.id))
    : assetSupplierRows;

  // Also get suppliers linked via documents
  const docSupplierRows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      phone: suppliers.phone,
    })
    .from(documentSuppliers)
    .innerJoin(assetFiles, eq(documentSuppliers.documentId, assetFiles.id))
    .innerJoin(suppliers, and(eq(suppliers.id, documentSuppliers.supplierId), eq(suppliers.accountId, accountId)))
    .where(and(
      eq(assetFiles.assetId, assetId),
      eq(assetFiles.accountId, accountId),
      isNull(assetFiles.deletedAt),
    ));

  const allCandidateSupplierIds = new Set(candidateSuppliers.map(s => s.id));
  for (const s of docSupplierRows) {
    if (!allCandidateSupplierIds.has(s.id) && !linkedSupplierIds.includes(s.id)) {
      candidateSuppliers.push(s);
      allCandidateSupplierIds.add(s.id);
    }
  }

  // 6. If nothing to analyze, return empty result
  const documentsResult = docs.linkedDocuments.map((id) => ({ id, score: 1, reason: 'Rapprochement document ↔ équipement (données structurées)' }));
  if (candidateAgendaItems.length === 0 && candidateSuppliers.length === 0) {
    return {
      documents: documentsResult, agendaItems: [], suppliers: [],
      applied: { documentsLinked: docs.linkedDocuments.length, agendaLinked: 0, suppliersLinked: 0 },
      documentSync: docs,
    };
  }

  // 7. Deterministic matching — resolve clear cases first
  const { clear, ambiguous } = resolveDeterministically(
    equip.name,
    equip.type,
    candidateAgendaItems,
    candidateSuppliers,
  );

  // 8. If all candidates resolved deterministically → skip AI entirely
  const hasAmbiguous =
    ambiguous.agendaItems.length > 0 ||
    ambiguous.suppliers.length > 0;

  let aiMatchedAgenda: { id: number; score: number; reason: string }[] = [];
  let aiMatchedSuppliers: { id: number; score: number; reason: string }[] = [];

  if (hasAmbiguous) {
    // 9. Call AI only for remaining ambiguous candidates
    const linked = await reconcileLinks({
      accountId,
      variables: {
        SUBJECT_CONTEXT: profil
          ? formatEquipmentSubject(profil, profils.filter((p) => p.id !== equipmentId))
          : `Équipement "${equip.name}" (type: ${equip.type ?? 'non spécifié'}` + `${equip.substructureId ? `, pièce #${equip.substructureId}` : ''})`,
        DOCUMENTS_LIST: '(sans objet)',
        AGENDA_LIST: buildAgendaList(ambiguous.agendaItems),
        SUPPLIERS_LIST: buildSuppliersList(ambiguous.suppliers),
        EQUIPMENTS_LIST: '(sans objet)',
      },
      sourceIds: [],
    });

    await reportLinkAmbiguities({ accountId, subject: `équipement #${equipmentId}` }, linked.ambiguities);

    const threshold = LINK_SCORE_THRESHOLDS.equipmentToObjects;
    aiMatchedAgenda = retainAbove(linked.agendaItems, threshold);
    aiMatchedSuppliers = retainAbove(linked.suppliers, threshold);
  }

  // 10. Merge deterministic + AI results (deduplicated)
  const allMatchedAgendaIds = new Set(clear.agendaItems.map(a => a.id));
  for (const a of aiMatchedAgenda) {
    if (!allMatchedAgendaIds.has(a.id)) {
      clear.agendaItems.push(a);
      allMatchedAgendaIds.add(a.id);
    }
  }

  const allMatchedSupplierIds = new Set(clear.suppliers.map(s => s.id));
  for (const s of aiMatchedSuppliers) {
    if (!allMatchedSupplierIds.has(s.id)) {
      clear.suppliers.push(s);
      allMatchedSupplierIds.add(s.id);
    }
  }

  // 11. Apply links in DB
  let agendaLinked = 0;
  let suppliersLinked = 0;

  if (clear.agendaItems.length > 0) {
    const validAgendaIds = clear.agendaItems
      .map(a => a.id)
      .filter(id => candidateAgendaItems.some(i => i.id === id));

    for (const agendaId of validAgendaIds) {
      // Insertion bornée au compte (élément d'agenda ET équipement).
      const r = (await db.execute(sql`
        INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id)
        SELECT ${agendaId}, ${equipmentId}
         WHERE ${ownedSql('agenda_item', agendaId, accountId)} AND ${ownedSql('equipment', equipmentId, accountId)}
        ON CONFLICT DO NOTHING RETURNING id`)) as unknown as unknown[];
      if (r.length) agendaLinked++;
    }
  }

  for (const sup of clear.suppliers) {
    const supExists = candidateSuppliers.find(s => s.id === sup.id);
    if (!supExists) continue;
    // Insertion bornée au compte (équipement ET fournisseur).
    const r = (await db.execute(sql`
      INSERT INTO equipment_suppliers (equipment_id, supplier_id, source_type, is_primary)
      SELECT ${equipmentId}, ${sup.id}, 'manual', false
       WHERE ${ownedSql('equipment', equipmentId, accountId)} AND ${ownedSql('supplier', sup.id, accountId)}
      ON CONFLICT DO NOTHING RETURNING equipment_id`)) as unknown as unknown[];
    if (r.length) suppliersLinked++;
  }

  return {
    documents: documentsResult,
    agendaItems: clear.agendaItems,
    suppliers: clear.suppliers,
    applied: { documentsLinked: docs.linkedDocuments.length, agendaLinked, suppliersLinked },
    documentSync: docs,
  };
}

// ── Document → Equipment linker (called after document validation) ─────────────

/**
 * Rattache un document aux équipements de son bien (parcours
 * DOCUMENT_EQUIPMENT). Lot 71A : délègue au service commun
 * (`document-equipment-link.service`) — données structurées d'abord (cible
 * T1 vérifiée, n° de série exact et unique, modèle, désignation non
 * ambiguë), T3 avec un contexte enrichi pour les seules vraies ambiguïtés,
 * carte LINK-ELT sinon. Plus de correspondance partielle « le nom contient »
 * ni de premier candidat retenu par défaut (choix arbitraire entre deux
 * équipements similaires). Ne lève pas.
 */
export async function linkDocumentToEquipments(
  assetFileId: number,
  accountId: number,
): Promise<void> {
  try {
    const { syncDocumentEquipmentLinks } = await import('./document-equipment-link.service');
    await syncDocumentEquipmentLinks({ accountId, fileId: assetFileId, allowAi: true });
  } catch (err) {
    console.error('[equipment-auto-link] rattachement document → équipements (non bloquant) :', (err as Error).message);
  }
}
