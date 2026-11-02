/**
 * Fournisseurs / intervenants des éléments d'Agenda — RÈGLES PURES (lot 103E,
 * ticket P1 « Agenda / Fournisseurs »). Aucune dépendance base ni réseau :
 * partagées par le service (`services/agenda/agenda-suppliers.ts`), le
 * contrôle de cohérence COH-AGENDA-SUPPLIERS, les écrans et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PROVENANCE ET AUTORITÉ D'UN LIEN (colonne `provenance`)
 *
 *   USER      geste de l'utilisateur — autorité maximale : jamais retiré ni
 *             remplacé par un traitement automatique ;
 *   DOCUMENT  document DIRECTEMENT rattaché à l'élément (provenance du lien
 *             document MANUAL_DIRECT ou AI_DIRECT — jamais OPERATION_PRINCIPAL,
 *             qui n'est qu'une appartenance au même événement de référence)
 *             dont le fournisseur est établi de façon FIABLE par le moteur
 *             fournisseurs des documents (lien confirmé, ou lu avec certitude
 *             par T1 — même règle que l'équivalence de prestataires 86C) ;
 *   AUTO      mention EXPLICITE et non ambiguë du nom d'un fournisseur du
 *             compte dans le libellé ou la description de l'élément.
 *
 * Jamais : l'appartenance au même événement de référence ou au même bien, un
 * équipement commun, un document seulement voisin, un lien fournisseur
 * incertain, une preuve de paiement (l'émetteur est la banque, pas
 * l'intervenant), un nom d'un seul mot (marque / mot courant : ambiguïté).
 *
 * Retrait manuel : mémorisé (`agenda_item_supplier_suppressions`) — aucun
 * traitement automatique ne recrée le lien sans nouveau geste.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type AgendaSupplierProvenance = 'USER' | 'DOCUMENT' | 'AUTO';

/** Rang d'autorité (le plus fort l'emporte quand deux sources désignent le même fournisseur). */
export const AGENDA_SUPPLIER_PROVENANCE_RANK: Readonly<Record<AgendaSupplierProvenance, number>> = { USER: 3, DOCUMENT: 2, AUTO: 1 };

/** Paramètres centralisés (aucune règle métier en dur ailleurs). */
export const AGENDA_SUPPLIER_RULES = {
  /** Fournisseurs au plus par élément (garde-fou d'API, pas une règle métier visible). */
  maxPerItem: 30,
  /** Longueur maximale d'un nom saisi pour créer un fournisseur depuis le tiroir. */
  maxNameLength: 200,
  /** Mention textuelle : nombre minimal de mots significatifs du nom normalisé. */
  mentionMinTokens: 2,
  /** Mention textuelle : longueur minimale (caractères) du nom normalisé. */
  mentionMinLength: 6,
  /** Provenances du lien document → élément qui valent preuve PROPRE à l'élément. */
  directFileLinkProvenances: ['MANUAL_DIRECT', 'AI_DIRECT'] as readonly string[],
  /**
   * Rôles de source (candidat d'événement de référence) dont le fournisseur
   * n'est PAS l'intervenant : preuve de paiement (émetteur = banque).
   */
  nonActorSourceRoles: ['PAYMENT_PROOF'] as readonly string[],
  /** Score de confiance d'un lien document → fournisseur lu avec certitude par T1. */
  reliableConfidence: 1,
  /** Éléments examinés au plus par passage d'auto-identification ciblée. */
  syncBatch: 200,
} as const;

/** Mots-outils ignorés dans le décompte des mots significatifs d'un nom. */
const MOTS_OUTILS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'l', 'd', 'a', 'au', 'aux', 'en', 'the', 'and', 'of']);

/** Normalisation pour la comparaison de textes (casse, accents, ponctuation). */
export function normalizeForMention(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[œ]/g, 'oe').replace(/[æ]/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface MentionSupplier { id: number; normalizedName: string }

export interface MentionResult {
  /** Fournisseurs mentionnés sans ambiguïté. */
  matched: number[];
  /** Noms mentionnés portés par plusieurs fiches (aucun lien : ambiguïté). */
  ambiguous: string[];
}

/** Le nom normalisé est-il assez distinctif pour valoir preuve par simple mention ? */
export function isDistinctiveName(normalizedName: string): boolean {
  const n = normalizeForMention(normalizedName);
  const mots = n.split(' ').filter((w) => w.length >= 2 && !MOTS_OUTILS.has(w));
  return mots.length >= AGENDA_SUPPLIER_RULES.mentionMinTokens && n.length >= AGENDA_SUPPLIER_RULES.mentionMinLength;
}

/**
 * Fournisseurs EXPLICITEMENT mentionnés dans un texte (libellé + description
 * de l'élément). Règles : nom distinctif (≥ 2 mots significatifs), présent en
 * mots entiers ; un nom inclus dans un nom plus long également mentionné est
 * écarté (« Durand Plomberie » dans « Durand Plomberie Chauffage ») ; deux
 * fiches de même nom → ambiguïté, aucun lien. Pure.
 */
export function findSupplierMentions(text: string, suppliers: readonly MentionSupplier[]): MentionResult {
  const t = ` ${normalizeForMention(text)} `;
  if (t.trim() === '') return { matched: [], ambiguous: [] };
  const parNom = new Map<string, number[]>();
  for (const s of suppliers) {
    const n = normalizeForMention(s.normalizedName);
    if (!n || !isDistinctiveName(n)) continue;
    if (!t.includes(` ${n} `)) continue;
    parNom.set(n, [...(parNom.get(n) ?? []), s.id]);
  }
  const noms = [...parNom.keys()];
  const retenus = noms.filter((n) => !noms.some((m) => m !== n && m.length > n.length && ` ${m} `.includes(` ${n} `)));
  const matched: number[] = [];
  const ambiguous: string[] = [];
  for (const n of retenus) {
    const ids = [...new Set(parNom.get(n) ?? [])];
    if (ids.length === 1) matched.push(ids[0]); else ambiguous.push(n);
  }
  return { matched: matched.sort((a, b) => a - b), ambiguous: ambiguous.sort() };
}

/** Preuve d'un lien automatique attendu. */
export interface AgendaSupplierEvidence {
  supplierId: number;
  provenance: Exclude<AgendaSupplierProvenance, 'USER'>;
  /** Document direct de l'élément (DOCUMENT). */
  documentId?: number | null;
  /** Champ de la mention (AUTO). */
  field?: 'title' | 'description' | null;
}

export interface CurrentAgendaSupplierLink { supplierId: number; provenance: AgendaSupplierProvenance }

export interface AgendaSupplierSyncPlan {
  /** Liens automatiques à poser (preuve fiable, aucun retrait manuel). */
  add: AgendaSupplierEvidence[];
  /** Liens automatiques dont la preuve a disparu (jamais un lien USER). */
  remove: Array<{ supplierId: number; provenance: AgendaSupplierProvenance }>;
  /** Liens automatiques dont la provenance change (ex. AUTO → DOCUMENT). */
  upgrade: AgendaSupplierEvidence[];
  /** Preuves écartées par un retrait manuel mémorisé (tracées, jamais appliquées). */
  suppressed: number[];
}

/**
 * Plan de synchronisation des liens AUTOMATIQUES d'un élément (pur,
 * idempotent : rejoué sur son propre résultat, il est vide).
 *   · preuve fiable, pas de lien, pas de retrait manuel → ajout ;
 *   · preuve fiable, lien automatique de rang inférieur → montée de rang ;
 *   · lien automatique sans preuve restante → retrait (sans mémoire : le lien
 *     reviendra si la preuve revient) ;
 *   · lien USER : jamais touché ; retrait manuel : jamais recréé.
 */
export function planAgendaSupplierSync(
  current: readonly CurrentAgendaSupplierLink[],
  evidence: readonly AgendaSupplierEvidence[],
  suppressedSupplierIds: readonly number[],
): AgendaSupplierSyncPlan {
  const meilleure = new Map<number, AgendaSupplierEvidence>();
  for (const e of evidence) {
    const deja = meilleure.get(e.supplierId);
    if (!deja || AGENDA_SUPPLIER_PROVENANCE_RANK[e.provenance] > AGENDA_SUPPLIER_PROVENANCE_RANK[deja.provenance]
      || (deja.provenance === e.provenance && (e.documentId ?? Infinity) < (deja.documentId ?? Infinity))) {
      meilleure.set(e.supplierId, e);
    }
  }
  const retires = new Set(suppressedSupplierIds);
  const actuels = new Map(current.map((c) => [c.supplierId, c]));
  const plan: AgendaSupplierSyncPlan = { add: [], remove: [], upgrade: [], suppressed: [] };
  for (const [sid, e] of [...meilleure.entries()].sort((a, b) => a[0] - b[0])) {
    const lien = actuels.get(sid);
    if (!lien) {
      if (retires.has(sid)) plan.suppressed.push(sid); else plan.add.push(e);
      continue;
    }
    if (lien.provenance !== 'USER' && AGENDA_SUPPLIER_PROVENANCE_RANK[e.provenance] > AGENDA_SUPPLIER_PROVENANCE_RANK[lien.provenance]) plan.upgrade.push(e);
  }
  for (const c of [...current].sort((a, b) => a.supplierId - b.supplierId)) {
    if (c.provenance === 'USER') continue;
    const e = meilleure.get(c.supplierId);
    if (!e) { plan.remove.push({ supplierId: c.supplierId, provenance: c.provenance }); continue; }
    // Preuve restante d'un rang INFÉRIEUR à la provenance enregistrée (document détaché, mention
    // toujours là) : la provenance redescend (retrait + ajout serait une perte d'historique).
    if (AGENDA_SUPPLIER_PROVENANCE_RANK[e.provenance] < AGENDA_SUPPLIER_PROVENANCE_RANK[c.provenance]) plan.upgrade.push(e);
  }
  return plan;
}

export const isEmptySyncPlan = (p: AgendaSupplierSyncPlan): boolean => p.add.length === 0 && p.remove.length === 0 && p.upgrade.length === 0;

/** Rubrique temporelle d'un élément dans la fiche fournisseur. */
export type AgendaSupplierTimeBucket = 'future' | 'past' | 'undated';

/** Passé / à venir / sans date (date civile du jour `today`, AAAA-MM-JJ). Pure. */
export function agendaTimeBucket(startDate: string | null, today: string): AgendaSupplierTimeBucket {
  if (!startDate) return 'undated';
  return startDate.slice(0, 10) < today ? 'past' : 'future';
}

export const AGENDA_SUPPLIER_BUCKET_LABELS: Readonly<Record<AgendaSupplierTimeBucket, string>> = {
  future: 'À venir',
  past: 'Passés',
  undated: 'Sans date',
};

/** Sélection du tiroir : fournisseurs existants + nouveaux noms à créer à l'enregistrement. */
export interface AgendaSuppliersPayload {
  supplierIds: number[];
  newSuppliers: Array<{ name: string; confirmNew?: boolean }>;
}

/**
 * Validation d'un `suppliers` reçu par l'API (création / modification d'un
 * élément). `undefined` : champ absent (rien ne change) ; `{ error }` :
 * refus 400 avant toute écriture. Pure.
 */
export function parseAgendaSuppliersPayload(raw: unknown): AgendaSuppliersPayload | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Fournisseurs : format invalide.' };
  const r = raw as { supplierIds?: unknown; newSuppliers?: unknown };
  const ids = r.supplierIds === undefined ? [] : r.supplierIds;
  const nouveaux = r.newSuppliers === undefined ? [] : r.newSuppliers;
  if (!Array.isArray(ids) || !Array.isArray(nouveaux)) return { error: 'Fournisseurs : format invalide.' };
  const supplierIds = [...new Set(ids.map((x) => Number(x)))];
  if (supplierIds.some((x) => !Number.isSafeInteger(x) || x <= 0)) return { error: 'Fournisseurs : identifiant invalide.' };
  const newSuppliers: AgendaSuppliersPayload['newSuppliers'] = [];
  const vus = new Set<string>();
  for (const n of nouveaux) {
    const name = typeof n === 'string' ? n : (n as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name.trim()) return { error: 'Fournisseurs : le nom du nouveau fournisseur est requis.' };
    const nom = name.trim().replace(/\s+/g, ' ');
    if (nom.length > AGENDA_SUPPLIER_RULES.maxNameLength) return { error: 'Fournisseurs : nom trop long.' };
    const cle = normalizeForMention(nom);
    if (!cle) return { error: 'Fournisseurs : nom invalide.' };
    if (vus.has(cle)) continue;
    vus.add(cle);
    newSuppliers.push({ name: nom, confirmNew: typeof n === 'object' && (n as { confirmNew?: unknown }).confirmNew === true });
  }
  if (supplierIds.length + newSuppliers.length > AGENDA_SUPPLIER_RULES.maxPerItem) return { error: 'Fournisseurs : trop de fournisseurs pour un même élément.' };
  return { supplierIds, newSuppliers };
}

/**
 * Ligne « Fournisseurs / intervenants » d'une description structurée (ICS,
 * exports) : NOMS seulement, jamais une coordonnée. `null` si aucun.
 */
export function supplierNamesLine(names: readonly string[]): string | null {
  const l = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  return l.length ? `Fournisseurs / intervenants : ${l.join(', ')}` : null;
}
