/**
 * titleCoherenceCheck
 * ───────────────────
 * Détecte les incohérences de nomenclature entre les titres de documents
 * d'un même compte : même fournisseur + même type de document = titres
 * doivent suivre la même convention de nommage.
 *
 * Stratégie (CDC V2 §12.2) :
 *   1. Règles déterministes d'abord : générer un titre attendu à partir
 *      du type documentaire, du fournisseur et de la date.
 *   2. Vérifier si le titre existant diverge du titre attendu.
 *   3. IA uniquement si le type documentaire est ambigu ou si le titre
 *      existant semble contradictoire de manière non triviale.
 */

import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';

export interface TitleInconsistencyDoc {
  id: number;
  currentTitle: string;
  suggestedTitle: string;
}

export interface TitleInconsistencyGroup {
  groupKey: string;
  fournisseur: string;
  documentType: string;
  issue: string;
  documents: TitleInconsistencyDoc[];
}

export interface TitleCoherenceResult {
  groups: TitleInconsistencyGroup[];
  hasIssues: boolean;
  checkedDocuments: number;
}

// ─── Déterministic title generation ─────────────────────────────────────────

/**
 * Génère un titre déterministe à partir du type de document, du fournisseur
 * et de la date. Évite un appel IA coûteux pour des cas simples.
 *
 * Exemples :
 *   "Facture EDF — 12 mai 2026"
 *   "Contrôle technique — Peugeot 208 — 2026"
 *   "Attestation d'assurance — Appartement Lyon"
 */
function generateDeterministicTitle(
  documentType: string,
  supplier: string,
  documentDate: string | null,
): string | null {
  if (!documentType || !supplier) return null;

  const type = documentType.toLowerCase().trim();
  const supplierName = supplier.trim();
  const dateStr = documentDate ? formatDateShort(documentDate) : null;

  // Map document types to readable French labels
  const typeLabels: Record<string, string> = {
    // Factures / paiements
    invoice: 'Facture',
    facture: 'Facture',
    receipt: 'Reçu',
    quittance: 'Quittance',
    payment_proof: 'Justificatif de paiement',
    echéancier: 'Échéancier',
    // Assurances
    insurance: "Attestation d'assurance",
    assurance: "Attestation d'assurance",
    insurance_certificate: "Attestation d'assurance",
    // Contrôles / diagnostics
    inspection: 'Contrôle technique',
    diagnostic: 'Diagnostic',
    dpe: 'DPE',
    control_technique: 'Contrôle technique',
    // Contrats / légaux
    contract: 'Contrat',
    bail: 'Bail',
    lease: 'Contrat de location',
    deed: 'Acte de propriété',
    compromis: 'Compromis de vente',
    // Équipements / entretien
    maintenance: "Compte-rendu d'entretien",
    garantie: 'Certificat de garantie',
    warranty: 'Certificat de garantie',
    // Identité / administratif
    id_card: "Carte d'identité",
    passport: 'Passeport',
    registration_certificate: 'Certificat dimmatriculation',
    carte_grise: 'Carte grise',
    // Documents techniques
    notice: 'Notice technique',
    manual: "Manuel d'utilisation",
    technical_sheet: 'Fiche technique',
    estimate: 'Devis',
    devis: 'Devis',
    // Divers
    certificate: 'Attestation',
    attestation: 'Attestation',
    report: 'Rapport',
    procès_verbal: 'Procès-verbal',
    pv: 'Procès-verbal',
  };

  const label = typeLabels[type] ?? null;
  if (!label) return null; // type inconnu → laisser l'IA décider

  // Build deterministic title
  if (dateStr) {
    return `${label} — ${supplierName} — ${dateStr}`;
  }
  return `${label} — ${supplierName}`;
}

/**
 * Format a date to a short French readable string.
 * Handles ISO YYYY-MM-DD and other common formats.
 */
function formatDateShort(dateStr: string): string {
  // Try ISO format first
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const monthIdx = parseInt(m) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${parseInt(d)} ${months[monthIdx]} ${y}`;
    }
    return `${y}`;
  }

  // French format DD/MM/YYYY
  const frMatch = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (frMatch) return formatDateShort(`${frMatch[3]}-${frMatch[2]}-${frMatch[1]}`);

  // Just return the year if we can parse it
  const yearMatch = dateStr.match(/(\d{4})/);
  if (yearMatch) return yearMatch[1];

  return dateStr;
}

// ─── Detect naming convention in a group ───────────────────────────────────

interface GroupConvention {
  pattern: 'supplier_first' | 'type_first' | 'date_prefix' | 'inconsistent' | 'uniform';
  titleCount: number;
}

/**
 * Analyse un groupe de documents pour détecter la convention de nommage
 * dominante. Retourne le pattern observé.
 */
function detectGroupConvention(
  docs: { id: number; title: string; date: string | null }[],
): GroupConvention {
  const conventions = docs.map(d => {
    const t = d.title.toLowerCase();
    if (/^\d{4}[\s\-:]/.test(t)) return 'date_prefix';
    return 'unknown';
  });

  const datePrefixCount = conventions.filter(c => c === 'date_prefix').length;
  const ratio = datePrefixCount / conventions.length;

  if (ratio > 0.6) return { pattern: 'date_prefix', titleCount: datePrefixCount };
  return { pattern: 'uniform', titleCount: conventions.length };
}

// ─── Main check function ───────────────────────────────────────────────────

export async function titleCoherenceCheck({
  accountId,
}: {
  accountId: number;
}): Promise<TitleCoherenceResult> {
  // 1. Load all documents with a retainedTitle (AI-generated) or originalFilename
  const docs = await db
    .select({
      id:               assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle:    assetFiles.retainedTitle,
      documentType:     assetFiles.documentType,
      supplier:         assetFiles.supplier,
      documentDate:     assetFiles.documentDate,
    })
    .from(assetFiles)
    .where(and(
      eq(assetFiles.accountId, accountId),
      isNull(assetFiles.deletedAt),
      eq(assetFiles.isWebLink, false),
      eq(assetFiles.isIgnored, false),
      isNotNull(assetFiles.supplier),
      isNotNull(assetFiles.documentType),
    ))
    .limit(500);

  if (docs.length === 0) return { groups: [], hasIssues: false, checkedDocuments: 0 };

  // 2. Group by (supplier + documentType), keep groups with ≥ 2 documents
  const groupMap = new Map<string, typeof docs>();
  for (const doc of docs) {
    if (!doc.supplier || !doc.documentType) continue;
    const key = `${doc.supplier.toLowerCase().trim()}__${doc.documentType}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(doc);
  }

  const groups: TitleInconsistencyGroup[] = [];

  for (const [groupKey, groupDocs] of groupMap.entries()) {
    if (groupDocs.length < 2) continue;

    const supplier = groupDocs[0].supplier!;
    const documentType = groupDocs[0].documentType!;

    // 3. For each doc, try to generate a deterministic title
    const issues: TitleInconsistencyDoc[] = [];

    for (const doc of groupDocs) {
      const currentTitle = doc.retainedTitle?.trim() || doc.originalFilename?.trim() || `Document ${doc.id}`;

      // Try deterministic title generation first
      const deterministicTitle = generateDeterministicTitle(documentType, supplier, doc.documentDate);

      if (deterministicTitle) {
        // Check if current title already follows the expected format
        const normalizedCurrent = currentTitle.toLowerCase().replace(/[^\w\s-]/g, '').trim();
        const normalizedExpected = deterministicTitle.toLowerCase().replace(/[^\w\s-]/g, '').trim();

        // Allow minor differences (e.g. "EDF" vs "EDF — 12/05/2026")
        const similarity = stringSimilarity(normalizedCurrent, normalizedExpected);

        if (similarity < 0.5) {
          // Title deviates significantly from expected format → suggest fix
          issues.push({
            id: doc.id,
            currentTitle,
            suggestedTitle: deterministicTitle,
          });
        }
        // else: title is close enough to expected → no issue
      }
      // else: unknown document type → cannot determine title without AI
    }

    if (issues.length > 0) {
      // Check if there's a dominant convention being violated
      const convention = detectGroupConvention(
        groupDocs.map(d => ({
          id: d.id,
          title: d.retainedTitle?.trim() || d.originalFilename?.trim() || '',
          date: d.documentDate,
        }))
      );

      let issue: string;
      if (convention.pattern === 'uniform') {
        issue = `Des titres de ce groupe ne suivent pas le format attendu : "${generateDeterministicTitle(documentType, supplier, null)}"`;
      } else {
        issue = `${issues.length} titre(s) ne suivent pas la convention de nommage du groupe`;
      }

      groups.push({
        groupKey,
        fournisseur: supplier,
        documentType,
        issue,
        documents: issues,
      });
    }
  }

  return {
    groups,
    hasIssues: groups.length > 0,
    checkedDocuments: docs.length,
  };
}

// ─── String similarity (Dice coefficient on bigrams) ────────────────────────

function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }

  let intersectionSize = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersectionSize++;
    }
  }

  return (2.0 * intersectionSize) / (a.length - 1 + b.length - 1);
}

/**
 * applyTitleCoherenceSuggestions
 * Applique les suggestions de renommage en base de données.
 * Met à jour retainedTitle pour chaque document concerné.
 */
export async function applyTitleCoherenceSuggestions({
  accountId,
  suggestions,
}: {
  accountId: number;
  suggestions: { id: number; suggestedTitle: string }[];
}): Promise<{ applied: number }> {
  let applied = 0;
  for (const s of suggestions) {
    if (!s.suggestedTitle?.trim()) continue;
    try {
      await db
        .update(assetFiles)
        .set({ retainedTitle: s.suggestedTitle.trim(), updatedAt: new Date() } as any)
        .where(and(
          eq(assetFiles.id, s.id),
          eq(assetFiles.accountId, accountId),
          isNull(assetFiles.deletedAt),
        ));
      applied++;
    } catch (err) {
      console.error(`[title-coherence] Failed to update doc ${s.id}:`, err);
    }
  }
  return { applied };
}