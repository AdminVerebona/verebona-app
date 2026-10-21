/**
 * Lot 77B — libellés UTILISATEUR des cartes « À traiter » (décision PO du
 * 21/10/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE POLITIQUE, APPLIQUÉE À LA LECTURE
 *
 * Les textes d'une carte (question, cible, propositions, contexte de source)
 * sont produits par une vingtaine de producteurs — dont des modèles (T3) dont
 * la justification est un texte libre — puis PERSISTÉS. Deux symptômes en
 * recette : « Historique fournisseur fourni par le serveur : 3 documents du
 * même émetteur Cardif IARD sont déjà rattachés à ce bien » (justification de
 * T3 recopiée telle quelle) et une cible « #9 » (événement d'agenda jamais
 * hydraté, repli sur l'identifiant).
 *
 * Plutôt qu'une migration de données, la file applique cette politique À LA
 * LECTURE (`getToProcessPage`) : la page, la pastille, l'accueil et la
 * mascotte (qui réutilise les mêmes vues) affichent tous des libellés
 * recalculés, y compris pour les actions déjà enregistrées. Les producteurs
 * concernés écrivent en plus des libellés propres à la source.
 *
 * Le BO (diagnostic) n'utilise PAS ce module : il peut rester technique.
 *
 * Module PUR (aucun accès base) : testé famille par famille.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getField } from '@/services/canonical/registry';
import type { ActionProposal, TargetType } from './action-model';

/** Motif interdit dans un libellé affiché à l'utilisateur. */
export interface ForbiddenLabelPattern {
  code: string;
  re: RegExp;
  /**
   * `true` : motif sûr même sur un texte qui CITE une donnée de l'utilisateur
   * (titre de document, nom de bien) — il ne peut pas y apparaître
   * légitimement. `false` : réservé aux textes entièrement produits par le
   * système (contexte de source, repli) — « Appartement T3 » est un nom de
   * bien légitime, « T3 » dans une justification est un nom de traitement.
   */
  safeOnUserContent: boolean;
}

/**
 * Formulations techniques interdites sur une carte (ticket 77B). Le test
 * l77b parcourt les familles et échoue si un libellé produit en contient une.
 */
export const FORBIDDEN_CARD_LABEL_PATTERNS: readonly ForbiddenLabelPattern[] = [
  { code: 'IDENTIFIANT_TECHNIQUE', re: /#\d+/, safeOnUserContent: true },
  { code: 'SERVEUR', re: /\bserveurs?\b/i, safeOnUserContent: true },
  { code: 'FOURNI_PAR', re: /\bfourni(?:e|s|es)? par\b/i, safeOnUserContent: true },
  { code: 'CODE_MAJUSCULES_SOULIGNES', re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/, safeOnUserContent: true },
  { code: 'CODE_DE_REGLE', re: /\b(?:DOC|DATA|LINK|AGENDA|OPERATION|SUPPLIER|MIG|ENTITY|ASSET)-[A-Z]+(?:-[A-Z]+)*\b/, safeOnUserContent: true },
  { code: 'VALEUR_BRUTE', re: /\[object Object\]|\b(?:undefined|NaN)\b|^\s*(?:null|true|false)\s*$/, safeOnUserContent: true },
  { code: 'DATE_ISO', re: /\b\d{4}-\d{2}-\d{2}\b/, safeOnUserContent: true },
  { code: 'REPLI_NUMEROTE', re: /^(?:Bien|Équipement|Pièce|Document|Fournisseur|Événement) \d+$/, safeOnUserContent: true },
  { code: 'CHAMP_ANGLAIS', re: /\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/, safeOnUserContent: false },
  // Nom de champ technique CITÉ entre guillemets (« floorCovering ») : jamais un titre saisi.
  { code: 'CHAMP_ANGLAIS_CITE', re: /«\s*[a-z]{2,}(?:[A-Z][a-z0-9]+)+\s*»/, safeOnUserContent: true },
  { code: 'NOM_DE_TRAITEMENT', re: /\bT[0-9]\b/, safeOnUserContent: false },
  { code: 'JARGON_INTERNE', re: /\b(?:score|confidence|candidat(?:e|s)?|signal(?:s|aux)?|preuve serveur|monde fermé|fingerprint|payload)\b/i, safeOnUserContent: false },
];

/** Codes des motifs interdits trouvés dans `text` (vide : libellé lisible). */
export function technicalLabelIssues(text: string | null | undefined, opts: { userContent?: boolean } = {}): string[] {
  if (!text) return [];
  return FORBIDDEN_CARD_LABEL_PATTERNS
    .filter((p) => (opts.userContent ? p.safeOnUserContent : true) && p.re.test(text))
    .map((p) => p.code);
}

/** Libellé générique d'une cible dont le nom est introuvable — jamais « #id ». */
export const TARGET_FALLBACK_LABELS: Readonly<Record<TargetType, string>> = {
  DOCUMENT: 'Document',
  ASSET: 'Bien',
  EQUIPMENT: 'Équipement',
  ROOM: 'Pièce',
  AGENDA_ITEM: 'Événement d’agenda',
  SUPPLIER: 'Fournisseur',
};

export function targetFallbackLabel(targetType: string): string {
  return TARGET_FALLBACK_LABELS[targetType as TargetType] ?? 'Élément';
}

/** Libellé d'un objet nommé dont le nom manque (« Bien sans nom »). */
export function unnamedLabel(kind: 'ASSET' | 'EQUIPMENT' | 'ROOM'): string {
  return kind === 'ASSET' ? 'Bien sans nom' : kind === 'EQUIPMENT' ? 'Équipement sans nom' : 'Pièce sans nom';
}

const frIso = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Dates ISO d'un texte → jj/mm/aaaa (« le 2026-05-12 » → « le 12/05/2026 »). */
export function humanizeIsoDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, (_m, d: string) => frIso(d));
}

/** « de Cardif IARD », « d’Allianz ». */
const deNom = (nom: string) => (/^[aeiouyàâäéèêëîïôöùûü]/i.test(nom) ? `d’${nom}` : `de ${nom}`);

/**
 * Historique fournisseur, formulation utilisateur (ticket 77B, cas 1) :
 * « Déjà 3 documents de Cardif IARD sur Maison ». Bien inconnu : « sur ce
 * bien » ; fournisseur inconnu : « du même fournisseur ».
 */
export function supplierHistoryLabel(p: { count: number; supplier?: string | null; assetName?: string | null }): string {
  const n = Math.max(1, Math.floor(p.count));
  const docs = n > 1 ? `${n} documents` : '1 document';
  const fournisseur = p.supplier?.trim() ? deNom(p.supplier.trim()) : 'du même fournisseur';
  const bien = p.assetName?.trim() ? p.assetName.trim() : 'ce bien';
  return `Déjà ${docs} ${fournisseur} sur ${bien}`;
}

/**
 * Historique fournisseur reconnu dans un texte produit par le serveur
 * (`semantic-search.ts` : « historique fournisseur : 3 document(s) du même
 * fournisseur déjà rattaché(s) à ce bien ») ou par le modèle, qui le
 * reformule (« … 3 documents du même émetteur Cardif IARD sont déjà
 * rattachés à ce bien »).
 */
const HISTORIQUE = /(\d+)\s+documents?(?:\(s\))?\s+(?:du\s+même\s+(?:fournisseur|émetteur|expéditeur)|de\s+ce\s+(?:fournisseur|émetteur))(?:\s+[«"“]?\s*(.+?)\s*[»"”]?)?\s+(?:(?:sont|est|étaient|était)\s+)?déjà\s+(?:rattaché|lié|classé|associé)/i;

/**
 * Contexte de source affiché sous les choix (§8.4), formulation utilisateur.
 * `null` : le texte reste technique — il n'est pas affiché (une ligne d'aide
 * absente vaut mieux qu'une ligne de jargon).
 */
export function userSourceLabel(
  raw: string | null | undefined,
  ctx: { assetName?: string | null; supplier?: string | null } = {},
): string | null {
  const texte = raw?.replace(/\s+/g, ' ').trim();
  if (!texte) return null;
  const h = HISTORIQUE.exec(texte);
  if (h) {
    const nomLu = h[2]?.replace(/^(?:de|du|d’|d')\s*/i, '').trim() || null;
    return supplierHistoryLabel({ count: Number(h[1]), supplier: nomLu ?? ctx.supplier ?? null, assetName: ctx.assetName ?? null });
  }
  const lisible = humanizeIsoDates(texte)
    // Préfixes de provenance technique (« … fourni par le serveur : »).
    .replace(/^[^:]{0,80}\b(?:fourni(?:e|s|es)? par le serveur|preuve serveur|côté serveur)\s*:\s*/i, '')
    .trim();
  if (!lisible) return null;
  if (technicalLabelIssues(lisible).length) return null;
  return lisible.charAt(0).toUpperCase() + lisible.slice(1);
}

/** Valeur brute → libellé (date, montant, booléen, vide). Pure. */
function valueText(label: string, fieldKey: string | null): string {
  const t = label.trim();
  if (t === '' || t === 'null' || t === 'undefined') return 'Aucune valeur';
  if (t === 'true') return 'Oui';
  if (t === 'false') return 'Non';
  const def = fieldKey ? getField(fieldKey) : undefined;
  if (def?.valueType === 'money_eur' && /^-?\d+(?:\.\d+)?$/.test(t)) {
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(t))} €`;
  }
  if (def?.valueType === 'money_cents' && /^-?\d+$/.test(t)) {
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(t) / 100)} €`;
  }
  return t;
}

/** Libellé d'une proposition, formulation utilisateur (lecture). Pure. */
export function userProposalLabel(label: string | null | undefined, fieldKey: string | null = null): string {
  const t = humanizeIsoDates(valueText(String(label ?? ''), fieldKey));
  const repli = /^(Bien|Équipement|Pièce) \d+$/.exec(t);
  if (repli) return unnamedLabel(repli[1] === 'Bien' ? 'ASSET' : repli[1] === 'Équipement' ? 'EQUIPMENT' : 'ROOM');
  return t || 'Aucune valeur';
}

/** Vue minimale d'une carte, telle que la file la rend. */
export interface CardLabelView {
  targetType: string;
  fieldKey: string | null;
  relationKey: string | null;
  ruleCode: string;
  question: string;
  proposals: ActionProposal[];
  target: { label: string; assetName?: string | null };
}

/**
 * Libellés d'une carte, prêts à afficher (page, mascotte, accueil). Pure.
 *   · cible : jamais « #id » ni vide → libellé générique du type ;
 *   · question : dates lisibles ; formulation technique → question du
 *     catalogue (`ruleQuestion`) ;
 *   · propositions : valeurs brutes formatées, replis numérotés nommés ;
 *   · contexte de source : reformulé (historique fournisseur) ou retiré.
 */
export function presentCardLabels<T extends CardLabelView>(view: T, ruleQuestion?: string | null): T {
  const label = view.target.label?.trim();
  // Un titre saisi peut contenir « #123 » (numéro de facture) : seul un
  // libellé qui n'est QU'UN identifiant est remplacé.
  const cible = !label || /^#?\d+$/.test(label) || /^(?:Bien|Équipement|Pièce|Document|Fournisseur) \d+$/.test(label)
    ? targetFallbackLabel(view.targetType) : label;
  const question = humanizeIsoDates(view.question ?? '');
  const linkAsset = view.targetType === 'DOCUMENT' && view.relationKey === 'assetIds';
  const proposals = view.proposals.map((p) => {
    const libelle = userProposalLabel(p.label, view.fieldKey);
    const { sourceContext, ...reste } = p;
    const source = sourceContext
      ? userSourceLabel(sourceContext.label, { assetName: linkAsset ? libelle : view.target.assetName ?? null })
      : null;
    return { ...reste, label: libelle, ...(source ? { sourceContext: { ...sourceContext!, label: source } } : {}) };
  });
  return {
    ...view,
    question: technicalLabelIssues(question, { userContent: true }).length && ruleQuestion ? ruleQuestion : question,
    proposals,
    target: { ...view.target, label: cible },
  };
}
