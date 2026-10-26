/**
 * Titre MÉTIER d'un document — moteur de composition (règle R9 du prompt T1,
 * lot 33C ; refonte lot 34E, ticket « Documents : refondre le moteur de titre
 * et assurer la repasse T3 sur l'existant »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NATURE + SUJET + DISCRIMINANTS UTILES
 *
 * Le titre du modèle n'est plus conservé « parce qu'il n'est pas technique » :
 * le moteur construit le MEILLEUR titre possible avec les données ACTUELLES
 * (analyse T1 persistée + état du compte), puis le service commun
 * (`DocumentTitleService`) le compare au titre en place
 * (`shouldReplaceSystemTitle`) — une simple reformulation n'est jamais une
 * amélioration.
 *
 *   Facture + fibre + Orange + septembre 2026 → « Facture fibre Orange _ Septembre 2026 »
 *   Facture + entretien + Polo + octobre 2026 → « Facture entretien Polo _ Octobre 2026 »
 *   Contrôle technique + Polo + 18/09/2026    → « Contrôle technique Polo _ 18 septembre 2026 »
 *
 * Discriminants (jamais tous obligatoires, jamais « Facture _ Orange _ Fibre
 * _ Maison _ 05/09/2026 _ FAC-456 ») :
 *   · fournisseur ;
 *   · cible : équipement (ou pièce) identifié — toujours utile ; bien — seulement
 *     si le compte en a plusieurs et qu'aucun fournisseur ne nomme déjà le
 *     document ;
 *   · période MÉTIER (période des faits : « Juillet à septembre 2026 ») plutôt
 *     que la date du document ; date du jour pour un événement ponctuel
 *     (contrôle, constat) ; mois de la date documentaire pour les documents
 *     récurrents (facture, quittance, avis d'échéance…) ; rien pour un
 *     contrat ou un certificat — sauf pour départager des titres identiques
 *     du compte (jamais « (2) ») ;
 *   · référence utile en dernier recours pour un doublon.
 * Rien n'est inventé : sans aucun élément exploitable, pas de titre.
 *
 * LOT 87D — RÈGLES v3 (ticket P1 « titres des factures périodiques ») :
 *   · facture PÉRIODIQUE (nature récurrente + fournisseur + mois principal
 *     décidé par l'IA ou période facturée) : convention unique
 *     « Facture Homiris — Février 2026 » (`document-title-convention.ts`) —
 *     ni sujet, ni cible, ni référence (le numéro de facture reste dans les
 *     métadonnées et la recherche ; il ne sert qu'à départager deux factures
 *     du même groupe) ;
 *   · séparateur unique « — » pour tous les titres automatiques ;
 *   · période présentée EXACTEMENT (`presentBilledPeriod`) ; plus aucun mois
 *     déduit de la date du document : une date utile est donnée au jour.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { resolveDocumentType } from '@/services/canonical/registry/catalogs';
import {
  DOCUMENT_TITLE_RULE_VERSION, normalizeTitle, titleHasPeriod, type TitleExpectations,
} from '@/lib/documents/document-title-rules';
import {
  canonicalTitleKey, composePeriodicTitle, disambiguatorFor, formatTitleDate, formatTitleMonth, PERIODIC_NATURES,
  presentBilledPeriod, presentSupplier, TITLE_CONVENTION_PERIODIC, TITLE_SEPARATOR,
  type DisambiguationMember, type PrincipalMonth, type TitleConvention,
} from '@/lib/documents/document-title-convention';
import type { SourceAnalysisResult } from './types';

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

/** Nature courte par type du catalogue documentaire (code canonique). */
const NATURE_BY_CODE: Record<string, string> = {
  FACTURE: 'Facture', DEVIS: 'Devis', BON_COMMANDE: 'Bon de commande', AVIS_ECHEANCE: 'Avis d’échéance',
  CONTRAT_ASSURANCE: 'Contrat d’assurance', CERTIFICAT_IMMATRICULATION: 'Certificat d’immatriculation',
  CONTROLE_TECHNIQUE: 'Contrôle technique', RAPPORT_ENTRETIEN: 'Rapport d’entretien', CERTIFICAT_GARANTIE: 'Garantie',
  DPE: 'DPE', DIAGNOSTIC: 'Diagnostic', CONSTAT_SINISTRE: 'Constat de sinistre', ACTE_AUTHENTIQUE: 'Acte',
  COMPROMIS_VENTE: 'Compromis de vente', CONTRAT_LOA: 'Contrat LOA', CONTRAT_LLD: 'Contrat LLD', MESURAGE_LEGAL: 'Mesurage',
};

/**
 * Natures reconnues en TÊTE du titre du modèle (forme normalisée → libellé).
 * Formes longues d'abord.
 */
const NATURE_PREFIXES: Array<[string, string]> = ([
  ['certificat d immatriculation', 'Certificat d’immatriculation'], ['controle technique', 'Contrôle technique'],
  ['contrat d assurance', 'Contrat d’assurance'], ['avis d echeance', 'Avis d’échéance'], ['bon de commande', 'Bon de commande'],
  ['bon de livraison', 'Bon de livraison'], ['rapport d entretien', 'Rapport d’entretien'], ['proces verbal', 'Procès-verbal'],
  ['facture', 'Facture'], ['devis', 'Devis'], ['avoir', 'Avoir'], ['quittance', 'Quittance'], ['contrat', 'Contrat'],
  ['attestation', 'Attestation'], ['releve', 'Relevé'], ['recu', 'Reçu'], ['ticket', 'Ticket'], ['garantie', 'Garantie'],
  ['notice', 'Notice'], ['diagnostic', 'Diagnostic'], ['echeancier', 'Échéancier'], ['bulletin', 'Bulletin'],
] as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length);

/** Natures RÉCURRENTES : le mois (ou la période) distingue les documents successifs. */
const RECURRING_NATURES = new Set(['Facture', 'Avoir', 'Quittance', 'Avis d’échéance', 'Relevé', 'Reçu', 'Ticket', 'Échéancier', 'Bulletin', 'Devis', 'Bon de commande', 'Bon de livraison']);
/** Natures PONCTUELLES : la date du jour identifie l'événement. */
const EVENT_NATURES = new Set(['Contrôle technique', 'Constat de sinistre', 'Rapport d’entretien', 'Procès-verbal']);

const GENERIC_SUBJECTS = new Set(['document', 'facture', 'article', 'produit', 'total', 'client', 'vendeur', 'fournisseur', 'tva', 'montant', 'prix', 'divers', 'service', 'prestation']);

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

/** Date du jour lisible (« 18 septembre 2026 », « 1er mars 2026 »). */
const dayMonthYear = (iso: string | null | undefined): string | null => formatTitleDate(iso);

/** Période métier PRÉSENTÉE EXACTEMENT (règle unique, `presentBilledPeriod`). */
const presentPeriod = (p: { start: string | null; end: string | null } | null | undefined): string | null =>
  (p ? presentBilledPeriod(p.start, p.end)?.label ?? null : null);

/**
 * Données de facturation PERSISTÉES d'un document (lot 87D) — ce que le titre
 * exploite et ce que la recherche indexe, avec la provenance de chaque champ.
 */
export interface BillingBasis {
  /** Période réellement facturée (montant d'échéance T1, sinon période des faits). */
  billedPeriod: { start: string; end: string; source: 'T1_INSTALLMENT' | 'T1_COST_PERIOD' | 'T1_FACT' } | null;
  /** Mois de rattachement principal décidé par l'IA (null tant que le contrat T1 ne le fournit pas). */
  principalMonth: PrincipalMonth | null;
  /** Références de facture lues (T1 `businessReferences[kind = INVOICE]`). */
  invoiceReferences: string[];
  /** Date d'émission (date du document). */
  issueDate: string | null;
}

export interface TitleContext {
  /** Code de type retenu par l'analyse (`invoice`, `FACTURE`, `MAINTENANCE_INVOICE`…). */
  typeCode?: string | null;
  /** Sujets des faits extraits, dans l'ordre (R8 : « Béquille draisienne »). */
  subjects?: string[];
  supplier?: string | null;
  documentDate?: string | null;
  // ── Lot 34E : connaissance ACTUELLE du compte (bornée, construite par le service) ──
  /** Période métier (faits du document). */
  period?: { start: string | null; end: string | null } | null;
  /** Bien rattaché (principal). */
  asset?: { id: number; name: string } | null;
  /** Équipement identifié (lien, cible d'un fait). */
  equipment?: { id: number; name: string } | null;
  /** Pièce identifiée. */
  room?: { id: number; name: string } | null;
  /** Nombre de biens actifs du compte (le nom du bien ne discrimine que s'il y en a plusieurs). */
  accountAssetCount?: number | null;
  /** Référence discriminante (n° de contrat…), dernier recours d'un doublon. */
  reference?: string | null;
  /** Titres SYSTEM similaires du compte (même nature), bornés. */
  similarTitles?: string[];
  // ── Lot 87D : convention périodique ──
  /** Données de facturation persistées (période facturée, mois principal IA, références, émission). */
  billing?: BillingBasis | null;
  /** Identifiant du document (désambiguïsation dans son groupe canonique). */
  selfId?: number | null;
  /** Autres documents du compte de MÊME clé canonique (bornés). */
  periodicSiblings?: DisambiguationMember[];
}

/** Éléments du meilleur titre et attentes (ce qu'un titre suffisant devrait porter). */
export interface TitlePlan {
  title: string | null;
  nature: string;
  subject: string | null;
  supplier: string | null;
  target: { kind: 'ASSET' | 'EQUIPMENT' | 'ROOM'; id: number; name: string } | null;
  period: string | null;
  reference: string | null;
  /** Le titre de base était identique à un titre du compte : discriminant ajouté. */
  duplicateResolved: boolean;
  expectations: TitleExpectations;
  /** Lot 87D : convention appliquée (`PERIODIC`), sinon null (composition générale). */
  convention: TitleConvention | null;
  /** Lot 87D : clé du groupe canonique (même nature, fournisseur, période), convention périodique seulement. */
  canonicalKey: string | null;
}

/** Nature du document : tête du titre du modèle, sinon type, sinon « Document ». */
function natureOf(modelTitle: string | null | undefined, typeCode: string | null | undefined): { nature: string; natureText: string; rest: string | null; prefixed: boolean } {
  // Nature lue en tête du titre du modèle, même réduit à une référence
  // (« Facture N° 2024-1187 » : nature Facture, aucun sujet).
  if (modelTitle && modelTitle.trim() && !/\.[a-z0-9]{2,5}$/i.test(modelTitle.trim())) {
    const brut = modelTitle.trim();
    const n = normalizeTitle(brut);
    for (const [forme, label] of NATURE_PREFIXES) {
      if (n === forme || n.startsWith(`${forme} `)) {
        // Retire autant de mots du titre original que la forme en compte.
        const nbMots = forme.split(' ').length;
        const mots = brut.split(/\s+/);
        let pris = 0;
        let i = 0;
        while (i < mots.length && pris < nbMots) {
          pris += Math.max(1, normalizeTitle(mots[i]).split(' ').filter(Boolean).length);
          i += 1;
        }
        const rest = mots.slice(i).join(' ').replace(/^[\s\-–—:_,]+/, '').trim();
        // Libellé canonique pour les règles ; formulation du modèle conservée à l'affichage.
        const natureText = mots.slice(0, i).join(' ');
        return { nature: label, natureText: natureText.charAt(0).toLocaleUpperCase('fr-FR') + natureText.slice(1), rest: rest || null, prefixed: true };
      }
    }
  }
  const entry = typeCode ? resolveDocumentType(typeCode) : undefined;
  const fromCatalog = entry ? NATURE_BY_CODE[entry.code] : undefined;
  const legacy = typeCode ? TYPE_LABELS[norm(typeCode)] : undefined;
  const nature = fromCatalog ?? legacy ?? 'Document';
  return {
    nature,
    natureText: nature,
    rest: modelTitle && !isReferenceOnlyTitle(modelTitle) ? modelTitle.trim() : null,
    prefixed: false,
  };
}

/** Retire d'un sujet ses dates / périodes (elles sont recomposées). */
function stripDates(s: string): string {
  return s
    .replace(/\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}(-\d{2})?)\b/g, ' ')
    .replace(/\b(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\b(\s+\d{4})?/gi, ' ')
    .replace(/\s[_—–]\s.*$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—:_,]+$/, '')
    .trim();
}

/** Ajoute `phrase` à `base` sans répéter les mots déjà présents (« entretien chaudière » + « Chaudière Saunier Duval »). */
function appendDistinct(base: string, phrase: string | null | undefined): string {
  if (!phrase) return base;
  const present = new Set(normalizeTitle(base).split(' '));
  const mots = phrase.trim().split(/\s+/).filter((m) => {
    const n = normalizeTitle(m);
    return n && !n.split(' ').every((t) => present.has(t));
  });
  return mots.length ? `${base} ${mots.join(' ')}` : base;
}

const MAX_TITLE = 120;
const MAX_BASE = 90;

/**
 * Meilleur titre constructible (pure). `title` null : aucune donnée
 * exploitable (ni sujet, ni fournisseur, ni cible, ni date).
 */
export function planBusinessTitle(modelTitle: string | null | undefined, ctx: TitleContext): TitlePlan {
  const { nature, natureText, rest, prefixed } = natureOf(modelTitle, ctx.typeCode);
  const supplier = ctx.supplier?.trim() || null;

  // Lot 87D — convention PÉRIODIQUE : « {Nature} {Fournisseur} — {Période} ».
  const periodique = periodicPlan(nature, supplier, ctx);
  if (periodique) return periodique;

  // Sujet : celui du titre du modèle quand il en a un ; le sujet STRUCTURÉ
  // des faits le remplace quand il y figure (« fibre internet » → « fibre »)
  // ou quand le titre n'en porte aucun (« Facture N° 2024-1187 »).
  const cibles = [supplier, ctx.asset?.name, ctx.equipment?.name, ctx.room?.name].filter((x): x is string => !!x).map(normalizeTitle);
  const factSubjects = (ctx.subjects ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !GENERIC_SUBJECTS.has(norm(s)) && normalizeTitle(s) !== normalizeTitle(nature) && !cibles.includes(normalizeTitle(s)));
  const stripped = rest ? stripDates(rest) : null;
  const titleSubject = stripped && /\p{L}{3,}/u.test(stripped) && !isReferenceOnlyTitle(`${nature} ${stripped}`) ? stripped : null;
  const contenu = titleSubject ? factSubjects.find((f) => ` ${normalizeTitle(titleSubject)} `.includes(` ${normalizeTitle(f)} `)) : undefined;
  const subject = titleSubject ? (contenu ?? titleSubject) : factSubjects[0] ?? null;

  // Cible : équipement / pièce toujours utiles ; bien seulement s'il discrimine.
  const target = ctx.equipment ? { kind: 'EQUIPMENT' as const, ...ctx.equipment }
    : ctx.room ? { kind: 'ROOM' as const, ...ctx.room }
      : ctx.asset && (ctx.accountAssetCount ?? 0) >= 2 && !supplier ? { kind: 'ASSET' as const, ...ctx.asset } : null;

  // Titre du modèle sans nature reconnue en tête (« Abonnement fibre
  // Orange ») : sa formulation est gardée telle quelle comme base.
  const ownWording = !prefixed && !!titleSubject && subject === titleSubject;
  let base = ownWording ? titleSubject! : subject ? `${natureText} ${subject}` : natureText;
  if (target) base = appendDistinct(base, target.name);
  if (supplier && normalizeTitle(`${base} ${supplier}`).length <= MAX_BASE * 1.2) base = appendDistinct(base, supplier);
  if (base.length > MAX_BASE) base = base.slice(0, MAX_BASE).replace(/\s+\S*$/, '');

  // Période / date (lot 87D : période présentée exactement ; une date utile
  // est donnée AU JOUR — jamais un mois déduit de la date du document).
  const periodeMetier = presentPeriod(ctx.period);
  let period = periodeMetier
    ?? (EVENT_NATURES.has(nature) || RECURRING_NATURES.has(nature) ? dayMonthYear(ctx.documentDate) : null);
  // Rien d'autre que la nature : la date du document distingue.
  if (!period && !subject && !supplier && !target && !ownWording) period = dayMonthYear(ctx.documentDate);
  if (period && titleHasPeriod(base)) period = null;

  const hasData = !!(subject || supplier || target || period || ctx.documentDate);
  const compose = (p: string | null, ref: string | null) => [base, p, ref].filter(Boolean).join(TITLE_SEPARATOR).slice(0, MAX_TITLE).trim();

  // Doublons du compte : discriminant métier plutôt que « (2) ».
  const similaires = new Set((ctx.similarTitles ?? []).map(normalizeTitle));
  let reference: string | null = null;
  let duplicateResolved = false;
  let title = hasData ? compose(period, null) : null;
  if (title && similaires.has(normalizeTitle(title))) {
    const options: Array<[string | null, string | null]> = [];
    if (!period) options.push([dayMonthYear(ctx.documentDate), null]);
    options.push([period ?? dayMonthYear(ctx.documentDate), null]);
    if (ctx.reference) options.push([period, ctx.reference]);
    for (const [p, r] of options) {
      const t = compose(p, r);
      if (t && !similaires.has(normalizeTitle(t))) { title = t; period = p; reference = r; duplicateResolved = true; break; }
    }
  }
  // Rien qu'une nature (« Document », « Facture ») : pas un titre.
  if (title && !subject && !supplier && !target && !period) title = null;

  return {
    title, nature, subject, supplier, target, period, reference, duplicateResolved,
    expectations: {
      nature, subject, supplier,
      target: target ? { kind: target.kind, name: target.name } : null,
      period, duplicates: [...(ctx.similarTitles ?? [])],
    },
    convention: null,
    canonicalKey: null,
  };
}

/**
 * Lot 87D — plan de la convention PÉRIODIQUE (pure), ou null si le document
 * n'en relève pas : nature récurrente, fournisseur connu, ET mois principal
 * décidé par l'IA (certain) ou période facturée présentable. La période n'est
 * jamais interprétée ici : mois principal IA, sinon période exacte.
 */
function periodicPlan(nature: string, supplier: string | null, ctx: TitleContext): TitlePlan | null {
  if (!PERIODIC_NATURES.has(nature) || !supplier) return null;
  const b = ctx.billing;
  if (!b) return null;
  const period = (b.principalMonth ? formatTitleMonth(b.principalMonth.value) : null)
    ?? (b.billedPeriod ? presentBilledPeriod(b.billedPeriod.start, b.billedPeriod.end)?.label ?? null : null);
  if (!period) return null;
  const fournisseur = presentSupplier(supplier);
  const canonicalKey = canonicalTitleKey(nature, fournisseur, period);
  const self: DisambiguationMember = { id: ctx.selfId ?? 0, invoiceReferences: b.invoiceReferences, issueDate: b.issueDate };
  const reference = disambiguatorFor(self, ctx.periodicSiblings ?? []);
  const title = composePeriodicTitle({ nature, supplier: fournisseur, period, disambiguator: reference }).slice(0, MAX_TITLE).trim();
  return {
    title, nature, subject: null, supplier: fournisseur, target: null, period, reference, duplicateResolved: reference !== null,
    expectations: { nature, subject: null, supplier: fournisseur, target: null, period, duplicates: [] },
    convention: TITLE_CONVENTION_PERIODIC,
    canonicalKey,
  };
}

/** Empreinte du contexte UTILE au titre (pure) : version des règles + éléments retenus. */
export function titleContextFingerprint(plan: TitlePlan): string {
  return createHash('sha256').update(JSON.stringify({
    v: DOCUMENT_TITLE_RULE_VERSION,
    n: plan.nature, s: plan.subject, f: plan.supplier,
    t: plan.target ? [plan.target.kind, plan.target.id, plan.target.name] : null,
    p: plan.period, r: plan.reference, d: plan.duplicateResolved,
    c: plan.convention, k: plan.canonicalKey,
  })).digest('hex');
}

/** Entrées du titre lues d'un résultat d'analyse : titre du modèle et contexte. */
export interface TitleInputs {
  modelTitle: string | null;
  ctx: TitleContext;
}

/**
 * Entrées du titre d'un résultat d'analyse T1 — mêmes champs qu'avant le
 * lot 33C (titre R9, type, sujets des faits et observations, fournisseur,
 * date). Partiel accepté : un run persisté ancien peut ne pas tout porter.
 */
export function titleInputsFromAnalysis(
  result: { document?: Partial<SourceAnalysisResult['document']> | null; extractedFields?: Array<{ subject?: string | null }> | null },
): TitleInputs {
  const d = result.document ?? {};
  return {
    modelTitle: d.title?.value ?? null,
    ctx: {
      typeCode: d.type?.value ?? null,
      subjects: [
        ...(result.extractedFields ?? []).map((f) => f?.subject),
        ...(d.visual?.observations ?? []).map((o) => o?.subject),
      ].filter((s): s is string => typeof s === 'string' && s.length > 0),
      supplier: d.supplier?.value?.name ?? null,
      documentDate: d.date?.value ?? null,
    },
  };
}
