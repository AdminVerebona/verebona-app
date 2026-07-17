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
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/db';
import {
  equipments, assetFiles, agendaItems, agendaAssetLinks, agendaEquipmentLinks,
  suppliers, assetSuppliers, equipmentSuppliers, documentSuppliers,
} from '@/db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutoLinkResult {
  documents: { id: number; score: number; reason: string }[];
  agendaItems: { id: number; score: number; reason: string }[];
  suppliers: { id: number; score: number; reason: string }[];
  applied: {
    documentsLinked: number;
    agendaLinked: number;
    suppliersLinked: number;
  };
}

interface CandidateDoc {
  id: number;
  title: string | null;
  filename: string | null;
  docType: string | null;
  documentDate: string | null;
  supplier: string | null;
  amountCents: number | null;
  description: string | null;
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

// ── Prompt loader ─────────────────────────────────────────────────────────────

function loadPrompt(): string {
  const path = join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'equipment_link_v1.txt');
  return readFileSync(path, 'utf8');
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildDocumentsList(docs: CandidateDoc[]): string {
  if (docs.length === 0) return 'Aucun document disponible.';
  return docs.map(d => {
    const title = d.title ?? d.filename ?? `Document #${d.id}`;
    const parts = [`[id:${d.id}] "${title}"`];
    if (d.docType) parts.push(`type:${d.docType}`);
    if (d.documentDate) parts.push(`date:${d.documentDate}`);
    if (d.supplier) parts.push(`fournisseur:"${d.supplier}"`);
    if (d.amountCents != null) parts.push(`montant:${(d.amountCents / 100).toFixed(2)}€`);
    if (d.description) parts.push(`— ${d.description.slice(0, 100)}`);
    return parts.join(' | ');
  }).join('\n');
}

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

function sanitizeJson(text: string): unknown {
  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')),
    () => {
      const m = text.match(/```(?:json)?\s*([\s\S]+?)```/);
      if (!m) throw new Error('no block');
      return JSON.parse(m[1].trim());
    },
    () => {
      const s = text.indexOf('{'); const e = text.lastIndexOf('}');
      if (s === -1 || e === -1) throw new Error('no obj');
      return JSON.parse(text.slice(s, e + 1));
    },
  ];
  for (const fn of attempts) { try { return fn(); } catch { /* next */ } }
  throw new Error('No valid JSON found in Gemini response');
}

// ── Deterministic resolution ────────────────────────────────────────────────

/**
 * Applique le matching déterministe sur tous les candidats.
 * Retourne les matchs clairs (score ≥ seuil) et les ambigus (score ≥ seuil_bas).
 */
function resolveDeterministically(
  equipmentName: string,
  equipmentType: string | null,
  candidateDocs: CandidateDoc[],
  candidateAgenda: CandidateAgenda[],
  candidateSuppliers: CandidateSupplier[],
): {
  clear: { documents: AutoLinkResult['documents']; agendaItems: AutoLinkResult['agendaItems']; suppliers: AutoLinkResult['suppliers'] };
  ambiguous: { documents: CandidateDoc[]; agendaItems: CandidateAgenda[]; suppliers: CandidateSupplier[] };
} {
  const clearDocs: AutoLinkResult['documents'] = [];
  const ambiguousDocs: CandidateDoc[] = [];

  for (const doc of candidateDocs) {
    const { score, reason } = deterministicMatch(equipmentName, equipmentType, {
      title: doc.title ?? doc.filename,
      supplier: doc.supplier,
      description: doc.description,
    });
    if (score >= DETERMINISTIC_THRESHOLD) {
      clearDocs.push({ id: doc.id, score, reason });
    } else if (score >= AMBIGUOUS_THRESHOLD) {
      ambiguousDocs.push(doc);
    }
    // else: score too low → skip entirely (no link, no AI)
  }

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
    clear: { documents: clearDocs, agendaItems: clearAgenda, suppliers: clearSuppliers },
    ambiguous: { documents: ambiguousDocs, agendaItems: ambiguousAgenda, suppliers: ambiguousSuppliers },
  };
}

// ── Main service ──────────────────────────────────────────────────────────────

export async function runEquipmentAutoLink(
  equipmentId: number,
  accountId: number,
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
    .where(eq(equipments.id, equipmentId))
    .limit(1);

  if (!equip) throw new Error('Equipment not found');

  const assetId = equip.assetId;

  // 2. Get already-linked document IDs
  const alreadyLinkedDocs = await db
    .select({ id: assetFiles.id })
    .from(assetFiles)
    .where(and(eq(assetFiles.equipmentId, equipmentId), isNull(assetFiles.deletedAt)));
  const linkedDocIds = alreadyLinkedDocs.map(d => d.id);

  // 3. Get candidate documents (NOT yet linked)
  const allAssetDocs = await db
    .select({
      id: assetFiles.id,
      title: assetFiles.retainedTitle,
      filename: assetFiles.originalFilename,
      docType: assetFiles.retainedFunctionCode,
      documentDate: assetFiles.documentDate,
      supplier: assetFiles.supplier,
      amountCents: assetFiles.amountCents,
      description: assetFiles.description,
    })
    .from(assetFiles)
    .where(and(
      eq(assetFiles.assetId, assetId),
      eq(assetFiles.accountId, accountId),
      isNull(assetFiles.deletedAt),
    ));

  const candidateDocs = linkedDocIds.length > 0
    ? allAssetDocs.filter(d => !linkedDocIds.includes(d.id))
    : allAssetDocs;

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
    .innerJoin(suppliers, eq(suppliers.id, assetSuppliers.supplierId))
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
    .innerJoin(suppliers, eq(suppliers.id, documentSuppliers.supplierId))
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
  if (candidateDocs.length === 0 && candidateAgendaItems.length === 0 && candidateSuppliers.length === 0) {
    return {
      documents: [], agendaItems: [], suppliers: [],
      applied: { documentsLinked: 0, agendaLinked: 0, suppliersLinked: 0 },
    };
  }

  // 7. Deterministic matching — resolve clear cases first
  const { clear, ambiguous } = resolveDeterministically(
    equip.name,
    equip.type,
    candidateDocs,
    candidateAgendaItems,
    candidateSuppliers,
  );

  // 8. If all candidates resolved deterministically → skip AI entirely
  const hasAmbiguous =
    ambiguous.documents.length > 0 ||
    ambiguous.agendaItems.length > 0 ||
    ambiguous.suppliers.length > 0;

  let aiMatchedDocs: { id: number; score: number; reason: string }[] = [];
  let aiMatchedAgenda: { id: number; score: number; reason: string }[] = [];
  let aiMatchedSuppliers: { id: number; score: number; reason: string }[] = [];

  if (hasAmbiguous) {
    // 9. Call AI only for remaining ambiguous candidates
    let prompt = loadPrompt();
    prompt = prompt
      .replace('{{EQUIPMENT_NAME}}', equip.name)
      .replace('{{EQUIPMENT_TYPE}}', equip.type ?? 'Non spécifié')
      .replace('{{EQUIPMENT_ROOM}}', equip.substructureId ? `Pièce #${equip.substructureId}` : 'Non spécifié')
      .replace('{{DOCUMENTS_LIST}}', buildDocumentsList(ambiguous.documents))
      .replace('{{AGENDA_LIST}}', buildAgendaList(ambiguous.agendaItems))
      .replace('{{SUPPLIERS_LIST}}', buildSuppliersList(ambiguous.suppliers));

    let rawText: string | undefined;
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        // No API key — apply only deterministic matches
        aiMatchedDocs = [];
        aiMatchedAgenda = [];
        aiMatchedSuppliers = [];
      } else {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent([{ text: prompt }]);
        rawText = result.response.text();
        const parsed = sanitizeJson(rawText) as {
          documents?: { id: number; score: number; reason: string }[];
          agendaItems?: { id: number; score: number; reason: string }[];
          suppliers?: { id: number; score: number; reason: string }[];
        };

        aiMatchedDocs = (parsed.documents ?? []).filter(d => d.score >= 0.4);
        aiMatchedAgenda = (parsed.agendaItems ?? []).filter(a => a.score >= 0.4);
        aiMatchedSuppliers = (parsed.suppliers ?? []).filter(s => s.score >= 0.4);
      }
    } catch (err) {
      console.error('[equipment-auto-link] AI call failed (non-blocking):', err);
      // Deterministic matches are still applied even if AI fails
    }
  }

  // 10. Merge deterministic + AI results (deduplicated)
  const allMatchedDocIds = new Set(clear.documents.map(d => d.id));
  for (const d of aiMatchedDocs) {
    if (!allMatchedDocIds.has(d.id)) {
      clear.documents.push(d);
      allMatchedDocIds.add(d.id);
    }
  }

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
  let documentsLinked = 0;
  let agendaLinked = 0;
  let suppliersLinked = 0;

  for (const doc of clear.documents) {
    const docExists = candidateDocs.find(d => d.id === doc.id);
    if (!docExists) continue;
    await db
      .update(assetFiles)
      .set({ equipmentId })
      .where(eq(assetFiles.id, doc.id));
    documentsLinked++;
  }

  if (clear.agendaItems.length > 0) {
    const validAgendaIds = clear.agendaItems
      .map(a => a.id)
      .filter(id => candidateAgendaItems.some(i => i.id === id));

    for (const agendaId of validAgendaIds) {
      await db
        .insert(agendaEquipmentLinks)
        .values({ agendaItemId: agendaId, equipmentId })
        .onConflictDoNothing();
      agendaLinked++;
    }
  }

  for (const sup of clear.suppliers) {
    const supExists = candidateSuppliers.find(s => s.id === sup.id);
    if (!supExists) continue;
    await db
      .insert(equipmentSuppliers)
      .values({
        equipmentId,
        supplierId: sup.id,
        sourceType: 'manual',
        isPrimary: false,
      })
      .onConflictDoNothing();
    suppliersLinked++;
  }

  return {
    documents: clear.documents,
    agendaItems: clear.agendaItems,
    suppliers: clear.suppliers,
    applied: { documentsLinked, agendaLinked, suppliersLinked },
  };
}

// ── Document → Equipment linker (called after document analysis) ──────────────

const EQUIPMENT_MATCH_PROMPT = `Tu es un assistant de gestion de patrimoine (Verebona).
Un document vient d'être analysé. Détermine à quel(s) équipement(s) de la liste il appartient.

Document :
{{DOCUMENT_CONTEXT}}

Équipements disponibles sur ce bien :
{{EQUIPMENTS_LIST}}

Pour chaque équipement pertinent, retourne son id et un score de pertinence (0.0 à 1.0).
Ne retourne que les équipements avec un lien clairement justifiable (score >= 0.5).
Réponds uniquement en JSON valide.

Format attendu :
{ "matches": [ { "id": number, "score": number, "reason": "explication courte" } ] }`;

function deterministicDocumentEquipmentMatch(
  equipmentName: string,
  equipmentType: string | null,
  docTitle: string | null,
  docSupplier: string | null,
  docDescription: string | null,
): { score: number; reason: string } | null {
  const nameLower = equipmentName.toLowerCase();
  const titleLower = (docTitle ?? '').toLowerCase();
  const supplierLower = (docSupplier ?? '').toLowerCase();
  const descLower = (docDescription ?? '').toLowerCase();

  // Exact match on equipment name in document title
  if (titleLower.includes(nameLower)) {
    return { score: 0.95, reason: `Équipement "${equipmentName}" mentionné dans le titre` };
  }

  // Equipment name matches supplier name
  if (supplierLower.includes(nameLower)) {
    return { score: 0.85, reason: `Fournisseur "${docSupplier}" correspond à l'équipement "${equipmentName}"` };
  }

  // Equipment type matches document type
  if (equipmentType) {
    const typeLower = equipmentType.toLowerCase();
    if (titleLower.includes(typeLower) || descLower.includes(typeLower)) {
      return { score: 0.7, reason: `Type d'équipement "${equipmentType}" trouvé dans le document` };
    }
  }

  // Equipment name mentioned in description
  if (descLower.includes(nameLower)) {
    return { score: 0.6, reason: `Équipement "${equipmentName}" mentionné dans la description` };
  }

  return null; // pas de match clair → IA
}

/**
 * Link a document to equipments on the same asset.
 * Uses deterministic matching first, falls back to AI only for ambiguous cases.
 *
 * @param assetFileId - The document's asset file ID
 * @param accountId   - The account ID
 * @param equipmentCandidates - Optional pre-extracted equipment names from document analysis.
 *        When provided, documents are matched against DB equipments by name first,
 *        skipping both deterministic and AI matching entirely for clear matches.
 */
export async function linkDocumentToEquipments(
  assetFileId: number,
  accountId: number,
  equipmentCandidates?: Array<{ name: string; type: string | null; category: string | null; confidence: number; reason: string }>,
): Promise<void> {
  // Load the document
  const [doc] = await db
    .select({
      id: assetFiles.id,
      assetId: assetFiles.assetId,
      equipmentId: assetFiles.equipmentId,
      title: assetFiles.retainedTitle,
      filename: assetFiles.originalFilename,
      docType: assetFiles.retainedFunctionCode,
      documentDate: assetFiles.documentDate,
      supplier: assetFiles.supplier,
      amountCents: assetFiles.amountCents,
      description: assetFiles.description,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
    .limit(1);

  if (!doc || !doc.assetId) return;

  // Already linked to an equipment — skip
  if (doc.equipmentId) return;

  // Load all non-archived equipments on this asset
  const assetEquipments = await db
    .select({ id: equipments.id, name: equipments.name, type: equipments.type })
    .from(equipments)
    .where(and(eq(equipments.assetId, doc.assetId), isNull(equipments.archivedAt)));

  if (assetEquipments.length === 0) return;

  // Build document context
  const docTitle = doc.title ?? doc.filename ?? `Document #${doc.id}`;

  // ── Equipment candidates from analysis → match directly against DB ──
  if (equipmentCandidates && equipmentCandidates.length > 0) {
    const highConfCandidates = equipmentCandidates.filter(c => c.confidence >= 0.7);
    for (const candidate of highConfCandidates) {
      const nameLower = candidate.name.toLowerCase().trim();
      // Try exact match first
      let match = assetEquipments.find(e => e.name.toLowerCase().trim() === nameLower);
      // Try partial match (name contains candidate or vice versa)
      if (!match) {
        match = assetEquipments.find(e =>
          e.name.toLowerCase().includes(nameLower) || nameLower.includes(e.name.toLowerCase())
        );
      }
      if (match) {
        await db
          .update(assetFiles)
          .set({ equipmentId: match.id })
          .where(eq(assetFiles.id, assetFileId));
        return; // linked from analysis candidate — no AI needed
      }
    }
    // Candidates present but none matched → skip (don't fall through to AI)
    // The analysis already said what this document is about. If no equipment
    // matches, it's not a viable link. No need for further AI processing.
    return;
  }

  // ── Deterministic pass: try matching against all equipments ──
  const deterministicMatches: { id: number; score: number; reason: string }[] = [];
  const ambiguousEquipments: typeof assetEquipments = [];

  for (const equip of assetEquipments) {
    const match = deterministicDocumentEquipmentMatch(
      equip.name,
      equip.type,
      docTitle,
      doc.supplier,
      doc.description,
    );
    if (match && match.score >= 0.7) {
      deterministicMatches.push({ id: equip.id, score: match.score, reason: match.reason });
    } else {
      ambiguousEquipments.push(equip);
    }
  }

  // If deterministic found a clear match above threshold, use it
  if (deterministicMatches.length > 0) {
    deterministicMatches.sort((a, b) => b.score - a.score);
    await db
      .update(assetFiles)
      .set({ equipmentId: deterministicMatches[0].id })
      .where(eq(assetFiles.id, assetFileId));
    return;
  }

  // No deterministic match → try AI for remaining ambiguous equipments
  if (ambiguousEquipments.length === 0) return;

  const docParts = [`Titre: "${docTitle}"`];
  if (doc.docType) docParts.push(`Type: ${doc.docType}`);
  if (doc.documentDate) docParts.push(`Date: ${doc.documentDate}`);
  if (doc.supplier) docParts.push(`Fournisseur: "${doc.supplier}"`);
  if (doc.amountCents != null) docParts.push(`Montant: ${(doc.amountCents / 100).toFixed(2)}€`);
  if (doc.description) docParts.push(`Description: ${doc.description.slice(0, 150)}`);

  const equipmentsList = ambiguousEquipments
    .map(e => `[id:${e.id}] "${e.name}"${e.type ? ` (type: ${e.type})` : ''}`)
    .join('\n');

  const prompt = EQUIPMENT_MATCH_PROMPT
    .replace('{{DOCUMENT_CONTEXT}}', docParts.join(' | '))
    .replace('{{EQUIPMENTS_LIST}}', equipmentsList);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([{ text: prompt }]);
    const rawText = result.response.text();

    const parsed = sanitizeJson(rawText) as { matches?: { id: number; score: number; reason: string }[] };
    const matches = (parsed.matches ?? []).filter(m => m.score >= 0.5);

    if (matches.length === 0) return;

    // Link to the best-scoring equipment
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0];
    const validEquip = [...ambiguousEquipments, ...assetEquipments.filter(e =>
      deterministicMatches.some(m => m.id === e.id)
    )].find(e => e.id === best.id);
    if (!validEquip) return;

    await db
      .update(assetFiles)
      .set({ equipmentId: best.id })
      .where(eq(assetFiles.id, assetFileId));
  } catch (err) {
    console.error('[equipment-auto-link] AI match failed (non-blocking):', err);
  }
}