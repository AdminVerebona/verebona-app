/**
 * Règles déterministes de la projection T1 — CDC 15 T1-02, T1-06, U12 à U16,
 * matrice §13, §22.2 (« aucune règle métier critique ne doit exister
 * uniquement dans un prompt »).
 *
 * Les règles d'U14/U15/U16 sont écrites dans le master ; elles sont AUSSI
 * appliquées ici, sur la sortie du modèle, parce qu'un prompt se contourne et
 * qu'un filtre non. Chaque règle porte un code STABLE, tracé sur le fait
 * (`ruleCode`) ou dans l'avertissement : c'est ce code que la recette, les
 * indicateurs OBS-T1 et les traces citent.
 */
import { resolveDocumentType, type DocumentCatalogEntry } from '@/services/canonical/registry';

/** Codes des règles déterministes (ne jamais renommer : tracés en base). */
export const PROJECTION_RULES = {
  /** Justificatif d'achat du bien : documentDate → acquisitionDate (T1-02). */
  PURCHASE_RECEIPT_ACQUISITION_DATE: 'PURCHASE_RECEIPT_ACQUISITION_DATE',
  /** Justificatif d'achat du bien : amountCents → acquisitionPrice en euros (T1-02, T1-03). */
  PURCHASE_RECEIPT_ACQUISITION_PRICE: 'PURCHASE_RECEIPT_ACQUISITION_PRICE',
  /** Fait d'acquisition du modèle complété par l'événement purchase HISTORICAL (U14). */
  PURCHASE_EVENT_ON_ACQUISITION: 'PURCHASE_EVENT_ON_ACQUISITION',
  /** Facture de réparation / entretien : ni acquisitionPrice ni acquisitionDate (§13, U14, P-T1-03). */
  SERVICE_INVOICE_NO_ACQUISITION: 'SERVICE_INVOICE_NO_ACQUISITION',
  /** Achat d'une pièce / d'un accessoire : pas d'acquisition du bien (T1-02). */
  PART_PURCHASE_NO_ASSET_ACQUISITION: 'PART_PURCHASE_NO_ASSET_ACQUISITION',
  /** Événement purchase retiré d'un fait du bien sur une facture de prestation (U14). */
  SERVICE_INVOICE_NO_PURCHASE_EVENT: 'SERVICE_INVOICE_NO_PURCHASE_EVENT',
  /**
   * Finalité non établie (ex. FACTURE sans type V2) : acquisitionDate /
   * acquisitionPrice du modèle sans preuve d'achat du bien → connaissance
   * générique (U14 : l'acquisition doit être établie par la source).
   */
  ACQUISITION_WITHOUT_PURCHASE_PROOF: 'ACQUISITION_WITHOUT_PURCHASE_PROOF',
  /**
   * Nombre de lignes du ticket non établi (ni tableau, ni fait d'achat par
   * ligne, transcription sans pluralité visible) : prix tiré du total gardé
   * en `probable` — T3 en fait une proposition, jamais une application.
   */
  ACQUISITION_PRICE_LINE_COUNT_UNKNOWN: 'ACQUISITION_PRICE_LINE_COUNT_UNKNOWN',
  /** Prix d'acquisition tiré d'une ligne d'achat explicite du bien (ticket à plusieurs articles). */
  PURCHASE_LINE_ACQUISITION_PRICE: 'PURCHASE_LINE_ACQUISITION_PRICE',
  /** Document multi-biens : aucune règle d'acquisition déterministe (U8, T1-05). */
  MULTI_ASSET_NO_ACQUISITION_RULE: 'MULTI_ASSET_NO_ACQUISITION_RULE',
  /** Montant total non attribuable au seul bien (plusieurs articles achetés). */
  ACQUISITION_PRICE_NOT_ATTRIBUTABLE: 'ACQUISITION_PRICE_NOT_ATTRIBUTABLE',
  /** « Dernier entretien / contrôle » jamais converti en prochaine échéance (T1-06, U15). */
  LAST_EVENT_NOT_DEADLINE: 'LAST_EVENT_NOT_DEADLINE',
  /** Échéance identique à la date du dernier événement : doublon retiré (U15). */
  DEADLINE_EQUALS_LAST_EVENT: 'DEADLINE_EQUALS_LAST_EVENT',
  /** Date de réalisation du DPE jamais convertie en expiration (U16, P-T1-05). */
  DPE_DATE_NOT_EXPIRY: 'DPE_DATE_NOT_EXPIRY',
  /**
   * Échéance égale à la date du document, ou antérieure / égale à la date de
   * réalisation du même document et de la même cible : ce n'est pas une
   * échéance à venir (T1-06, U15, U16).
   */
  DEADLINE_NOT_AFTER_EVENT: 'DEADLINE_NOT_AFTER_EVENT',
} as const;
export type ProjectionRuleCode = (typeof PROJECTION_RULES)[keyof typeof PROJECTION_RULES];

/**
 * Couples « dernier événement réalisé » / « prochaine échéance » du registre
 * (§13 : entretien réalisé ≠ prochain entretien ; contrôle réalisé ≠ prochain
 * contrôle).
 */
export const LAST_VS_DEADLINE: ReadonlyArray<{ deadline: string; last: string }> = [
  { deadline: 'maintenanceDueDate', last: 'lastRevision' },
  { deadline: 'nextInspection', last: 'lastInspectionDate' },
];

/** Formulations d'un événement RÉALISÉ. */
const REALISE = /(dernier|derni[eè]re|effectu[ée]|r[ée]alis[ée]|intervention du|pass[ée] le|visite du)/i;
/** Formulations d'une échéance À VENIR. */
const A_VENIR = /(prochain|prochaine|avant le|[àa] pr[ée]voir|[àa] effectuer|[àa] faire|[ée]ch[ée]ance|au plus tard|next|due)/i;

/**
 * Un extrait qui énonce un événement réalisé sans aucune formulation
 * d'échéance ne peut pas prouver une prochaine date (T1-06).
 */
export function excerptStatesPastEventOnly(excerpt: string | undefined | null): boolean {
  if (!excerpt) return false;
  return REALISE.test(excerpt) && !A_VENIR.test(excerpt);
}

/** Écritures d'une date ISO dans un extrait (JJ/MM/AAAA, J/M/AAAA, JJ.MM.AAAA, JJ-MM-AAAA, AAAA-MM-JJ). */
function ecrituresDate(iso: string): RegExp | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  const j = `0?${Number(d)}`;
  const mm = `0?${Number(mo)}`;
  return new RegExp(`(${j}[/.\\-]${mm}[/.\\-]${y}|${y}-${mo}-${d})`, 'i');
}

/**
 * La date du fait est introduite, DANS l'extrait, par une formulation
 * d'événement réalisé (« Dernier entretien : 15/11/2026 — prochain dans 1
 * an ») : la date citée est celle de l'événement passé, même si l'extrait
 * parle ensuite d'une prochaine échéance sans la dater (T1-06).
 */
export function dateIntroducedAsPastEvent(excerpt: string | undefined | null, isoDate: unknown): boolean {
  if (!excerpt || typeof isoDate !== 'string') return false;
  const re = ecrituresDate(isoDate);
  const m = re ? re.exec(excerpt) : null;
  if (!m) return false;
  const avant = excerpt.slice(Math.max(0, m.index - 40), m.index);
  return REALISE.test(avant) && !A_VENIR.test(avant);
}

/** Formulations de réalisation d'un diagnostic. */
const DPE_REALISATION = /(r[ée]alis|[ée]tabli|date de (la )?visite|visite (du|le)|date du diagnostic|effectu|date d.?[ée]tablissement|\b(dpe|diagnostic)\s+(du|en date du)\b)/i;
/** Formulations d'une fin de validité. */
const DPE_EXPIRATION = /(valid|expir|jusqu|fin de|limite)/i;

/** L'extrait établit la réalisation du DPE, pas sa fin de validité (U16). */
export function excerptStatesDpeRealisationOnly(excerpt: string | undefined | null): boolean {
  if (!excerpt) return false;
  return DPE_REALISATION.test(excerpt) && !DPE_EXPIRATION.test(excerpt);
}

/**
 * Lignes d'articles lisibles dans une transcription de ticket, quand le
 * modèle n'a rendu ni tableau ni fait d'achat par ligne (T1-02).
 *
 * Heuristique volontairement simple : une ligne « libellé … montant » (au
 * moins deux lettres, puis un montant à deux décimales en fin de ligne,
 * devise facultative), en excluant les lignes de synthèse et de paiement
 * (total, sous-total, TVA, HT/TTC, remise, rendu, espèces, carte, CB,
 * payé, acompte, net à payer). Elle ne sert qu'à REFUSER un prix : deux
 * lignes ou plus ⇒ le total n'est pas le prix du bien.
 */
const LIGNE_ARTICLE = /[a-zà-ÿ]{2}.*\s\d{1,6}[.,]\d{2}\s*(€|eur|euros?)?\s*$/i;
const LIGNE_SYNTHESE = /(total|tva|\bht\b|\bttc\b|remise|rendu|esp[eè]ces|carte|\bcb\b|pay[ée]|acompte|net [àa] payer|montant|solde|avoir)/i;

export function countArticleLines(transcription: string | undefined | null): number {
  if (!transcription) return 0;
  return transcription.split(/\r?\n/).filter((l) => LIGNE_ARTICLE.test(l.trim()) && !LIGNE_SYNTHESE.test(l)).length;
}

/** Finalité du document, établie APRÈS classification (T1-02 « trois effets différents »). */
export type DocumentPurpose =
  /** Ticket / facture d'achat du bien, acte d'acquisition. */
  | 'ASSET_PURCHASE'
  /** Achat d'une pièce, d'un accessoire, d'un consommable. */
  | 'PART_PURCHASE'
  /** Réparation, entretien, travaux. */
  | 'SERVICE'
  | 'OTHER';

/** Types V2 dont la finalité est l'acquisition du bien. */
const V2_ACHAT_DU_BIEN = new Set(['ACQUISITION_INVOICE', 'ACQUISITION_PAYMENT']);
/** Types V2 de prestation (entretien, réparation, travaux). */
const V2_PRESTATION = /^(MAINTENANCE|REPAIR|WORKS)_/;
/** Types canoniques de prestation. */
const CANONIQUES_PRESTATION = new Set(['RAPPORT_ENTRETIEN']);

/** Le type documentaire peut-il PROUVER un achat (preuve `completed` de type purchase) ? */
export function provesPurchase(entry: DocumentCatalogEntry | undefined): boolean {
  return Boolean(entry?.businessTypes.includes('purchase') && entry.completionProofs.some(
    (p) => p.establishes === 'completed' && (p.businessTypes ?? entry.businessTypes).includes('purchase'),
  ));
}

/** Le type documentaire prouve-t-il un achat par une FACTURE (montant de transaction) ? */
export function provesPurchaseByInvoice(entry: DocumentCatalogEntry | undefined): boolean {
  return Boolean(entry?.completionProofs.some((p) => p.code === 'FACTURE_ACHAT'));
}

/** Entrée du DOCUMENT_CATALOG pour la classification du modèle. */
export function documentEntryOf(classification: {
  canonicalType?: string | null; documentTypeCode?: string | null;
} | undefined): DocumentCatalogEntry | undefined {
  return resolveDocumentType(classification?.canonicalType) ?? resolveDocumentType(classification?.documentTypeCode);
}

export interface PurposeSignals {
  entry: DocumentCatalogEntry | undefined;
  documentTypeCode: string | null;
  /**
   * Faits portant un événement purchase, avec le type de leur cible — HORS
   * faits d'acquisition eux-mêmes : un acquisitionDate proposé ne peut pas
   * prouver à lui seul qu'il y a eu achat (preuve circulaire, U14).
   */
  purchaseTargets: string[];
  /** Cibles des faits acquisitionDate / acquisitionPrice proposés par le modèle. */
  acquisitionClaims?: string[];
  /** Nombre de faits portant un événement repair/maintenance réalisé. */
  serviceEvents: number;
}

/**
 * Finalité du document :
 *   1. un type V2 de prestation (ou un rapport d'intervention) → SERVICE ;
 *   2. des achats énoncés, aucun sur le BIEN → PART_PURCHASE ;
 *   3. type prouvant un achat ET (type V2 d'acquisition OU ligne d'achat du
 *      bien énoncée OU acquisition énoncée par un acte) → ASSET_PURCHASE ;
 *   4. des prestations réalisées énoncées, aucun achat du bien → SERVICE.
 */
export function classifyPurpose(s: PurposeSignals): DocumentPurpose {
  const v2 = s.documentTypeCode?.trim().toUpperCase() ?? '';
  // Un acte authentique porte lui-même la transaction : l'acquisition qu'il
  // énonce vaut preuve. Une facture (SUPPORTING) doit dire sa finalité (type
  // V2) ou énoncer la ligne d'achat du bien.
  const assetPurchase = s.purchaseTargets.includes('ASSET')
    || (s.entry?.authority === 'AUTHORITATIVE' && (s.acquisitionClaims ?? []).includes('ASSET'));
  if (V2_PRESTATION.test(v2) || (s.entry && CANONIQUES_PRESTATION.has(s.entry.code))) return 'SERVICE';
  if (s.purchaseTargets.length > 0 && !assetPurchase) return 'PART_PURCHASE';
  if (provesPurchase(s.entry) && (V2_ACHAT_DU_BIEN.has(v2) || assetPurchase)) return 'ASSET_PURCHASE';
  if (s.serviceEvents > 0 && !assetPurchase) return 'SERVICE';
  return 'OTHER';
}
