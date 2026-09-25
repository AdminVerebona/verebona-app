/**
 * Titre d'un document — filet de sécurité de la règle R9 du prompt T1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « FACTURE N° 2024-1187 » NE DIT RIEN
 *
 * T1 titrait souvent les documents d'après leur numéro : dix factures
 * devenaient dix « Facture N° … » indiscernables. Le prompt v5 demande
 * « <Type> <ce qu'il concerne> » (« Facture Béquille draisienne »). Un modèle
 * peut pourtant encore rendre un numéro seul : ce module le détecte et
 * reconstruit un titre à partir de ce que l'analyse a extrait — l'objet
 * concerné, à défaut le fournisseur, à défaut le mois. Rien n'est inventé :
 * sans aucun de ces éléments, le titre du modèle est conservé.
 * ══════════════════════════════════════════════════════════════════════════
 */

const TYPE_WORDS = [
  'facture', 'devis', 'avoir', 'reçu', 'recu', 'ticket', 'quittance', 'commande', 'bon de commande',
  'bon de livraison', 'contrat', 'attestation', 'document', 'scan', 'justificatif', 'relevé', 'releve',
];

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Facture', facture: 'Facture', receipt: 'Reçu', quittance: 'Quittance', estimate: 'Devis',
  devis: 'Devis', contract: 'Contrat', insurance: 'Assurance', assurance: 'Assurance', warranty: 'Garantie',
  garantie: 'Garantie', notice: 'Notice', manual: 'Notice', diagnostic: 'Diagnostic', inspection: 'Contrôle technique',
  maintenance: 'Entretien', certificate: 'Attestation', attestation: 'Attestation',
};

const GENERIC_SUBJECTS = new Set(['document', 'facture', 'article', 'produit', 'total', 'client', 'vendeur', 'fournisseur']);

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Titre inexploitable pour distinguer un document : vide, générique, nom de
 * fichier, ou type suivi d'un simple numéro / référence.
 */
export function isReferenceOnlyTitle(title: string | null | undefined): boolean {
  if (!title || !title.trim()) return true;
  const t = norm(title);
  if (/\.(pdf|jpe?g|png|heic|webp|docx?)$/.test(t) || /^(img|scan|dsc|pxl)[_\- ]?\d+/.test(t)) return true;
  if (TYPE_WORDS.includes(t)) return true;
  const rest = TYPE_WORDS.reduce((acc, w) => (acc.startsWith(`${w} `) ? acc.slice(w.length + 1) : acc), t)
    .replace(/^(n[°o]\.?|numero|no\.?|num\.?|#|ref\.?|reference)\s*:?\s*/, '')
    .trim();
  // Ce qui reste n'est qu'une référence : un seul « mot » qui contient des
  // chiffres (« Facture N° 2024-1187 », ou « FA-2026-03 » tout seul).
  return /^[a-z0-9\-/_.]+$/.test(rest) && /\d/.test(rest);
}

function typeLabel(title: string | null | undefined, typeCode: string | null | undefined): string | null {
  const first = title ? norm(title).split(/\s+/)[0] : '';
  const fromTitle = TYPE_WORDS.includes(first) && first !== 'document' && first !== 'scan'
    ? first.charAt(0).toUpperCase() + first.slice(1)
    : null;
  if (fromTitle) return fromTitle.replace(/^Recu$/, 'Reçu').replace(/^Releve$/, 'Relevé');
  return typeCode ? TYPE_LABELS[norm(typeCode)] ?? null : null;
}

function monthYear(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export interface TitleContext {
  /** Code de type retenu par l'analyse (`invoice`, `facture`…). */
  typeCode?: string | null;
  /** Sujets des faits extraits, dans l'ordre (R8 : « Béquille draisienne »). */
  subjects?: string[];
  supplier?: string | null;
  documentDate?: string | null;
}

/** Titre à retenir : celui du modèle s'il distingue le document, sinon reconstruit. */
export function refineDocumentTitle(title: string | null | undefined, ctx: TitleContext): string | null {
  if (!isReferenceOnlyTitle(title)) return title!.trim();
  const label = typeLabel(title, ctx.typeCode) ?? 'Document';
  const subject = (ctx.subjects ?? [])
    .map((s) => s.trim())
    .find((s) => s.length >= 3 && !GENERIC_SUBJECTS.has(norm(s)));
  const named = subject ?? ctx.supplier?.trim();
  if (named) return `${label} ${named.charAt(0).toUpperCase()}${named.slice(1)}`.slice(0, 120);
  const period = monthYear(ctx.documentDate);
  return period ? `${label} ${period}` : title?.trim() || null;
}
