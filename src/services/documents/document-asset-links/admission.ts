/**
 * Lot 113AM (Trello #739) — GARDE D'ADMISSION d'un lien document ↔ bien.
 * Module PUR : aucune base, aucun appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL PRÉDICAT, AVANT CHAQUE ÉCRITURE AUTOMATIQUE
 *
 * `admitDocumentAssetLink` est appelé par les deux primitives d'écriture des
 * rattachements — `linkDocumentToAsset` (relation N-N) et
 * `ASSET_LINK_SLOT.writeAuto` (colonne principale, reflétée en lien
 * LEGACY_COLUMN par le déclencheur 0221) — pour TOUTE écriture qui n'est pas
 * une décision de l'utilisateur : projection T1 (import initial, reprise,
 * réanalyse), pont « À traiter », T3 DOCUMENT_ASSET (déterministe, identité
 * de groupe / rétroactif, IA), revue du rattachement (#711), faits sans cible,
 * équipements, rattrapage. Une écriture automatique SANS justification est
 * refusée (fail-closed).
 *
 * Règle (ticket #739, critère d'acceptation) : un lien n'est admis que s'il
 * repose sur au moins UNE preuve de pertinence pour le bien concerné. Une
 * adresse n'en est une que si son rôle est « lieu du bien objet du document »
 * (`PROPERTY_LOCATION`) ; l'adresse d'un destinataire, d'un souscripteur, de
 * l'émetteur, de facturation, de livraison, ou une adresse sans rôle établi
 * n'est jamais une preuve — un bien existant de même adresse ne suffit
 * jamais. Une décision IA (T3, revue) n'est admise que si elle s'appuie sur
 * autre chose qu'une telle adresse. Le contexte (ville, code postal,
 * catégorie, lien seulement cité) n'est jamais une preuve à lui seul.
 *
 * Aucune règle par fournisseur, type de document ou mot-clé : le rôle d'une
 * adresse est QUALIFIÉ en amont (`address-roles.ts`) à partir des sorties T1
 * existantes (cible du fait, libellés lus) ; ce prédicat ne lit que des
 * natures de preuve.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Version de la garde (journal, rattrapage). */
export const LINK_ADMISSION_VERSION = 1;

/**
 * Rôle d'une adresse lue dans un document, par rapport à UN bien candidat.
 *   · PROPERTY_LOCATION    lieu du bien objet du document (fait T1 ciblé sur
 *                          CE bien, ou libellé « adresse du bien / du risque /
 *                          des travaux… » qui la précède immédiatement) ;
 *   · OTHER_ASSET_LOCATION fait T1 ciblé sur un AUTRE bien ;
 *   · CORRESPONDENCE       destinataire, souscripteur, titulaire, client,
 *                          adresse de facturation / de correspondance ;
 *   · DELIVERY             adresse de livraison ;
 *   · ISSUER               émetteur / fournisseur (fait ciblé fournisseur,
 *                          siège, agence…) ;
 *   · INSTALLATION         lieu d'installation d'un appareil (ne prouve pas
 *                          l'appartenance au bien) ;
 *   · DOCUMENT_PARTY       fait T1 ciblé sur le document lui-même, sans rôle lu ;
 *   · UNQUALIFIED          aucun rôle établi.
 */
export const ADDRESS_ROLES = [
  'PROPERTY_LOCATION', 'OTHER_ASSET_LOCATION', 'CORRESPONDENCE', 'DELIVERY', 'ISSUER', 'INSTALLATION', 'DOCUMENT_PARTY', 'UNQUALIFIED',
] as const;
export type AddressRole = (typeof ADDRESS_ROLES)[number];

/** Nature d'une preuve de rattachement. */
export const LINK_PROOF_KINDS = [
  /** Choix de l'utilisateur (tiroir, carte, dépôt sur le bien). */
  'USER_DECISION',
  /** Bien connu au dépôt (KNOWN_TARGET humain). */
  'KNOWN_TARGET',
  /** Désignation par le MODÈLE T1 (candidat vérifié en monde fermé, jamais un enrichissement serveur). */
  'MODEL_DESIGNATION',
  /** Faits T1 ciblés sur le bien (cible vérifiée). */
  'FACT_TARGET',
  /** Identifiant canonique exact (adresse : seulement au rôle PROPERTY_LOCATION). */
  'IDENTIFIER',
  /** Même n° de contrat / police qu'un document déjà rattaché au bien. */
  'SHARED_REFERENCE',
  /** Nom ou alias discriminant du bien cité par le document. */
  'DISTINCT_NAME',
  /** Groupe d'identité documentaire (lot 105D) — `support` : identités du document. */
  'IDENTITY_GROUP',
  /** Décision IA T3 DOCUMENT_ASSET — `support` : sources du candidat retenu. */
  'AI_DECISION',
  /** Revue IA du rattachement (#711) — `support` : indices et faits du bien. */
  'AI_REVIEW',
  /** Cible structurelle : équipement / pièce identifié (numéro de série…), bien porteur déduit. */
  'STRUCTURAL',
  /** Simple contexte : ville, code postal, catégorie, marque, lien seulement cité. */
  'CONTEXT',
] as const;
export type LinkProofKind = (typeof LINK_PROOF_KINDS)[number];

export interface LinkProof {
  kind: LinkProofKind;
  /** Pour IDENTIFIER : ADDRESS, REGISTRATION, VIN, SERIAL, CADASTRAL. */
  identifierKind?: string;
  /** Pour une adresse : rôle qualifié (obligatoire pour qu'elle compte). */
  addressRole?: AddressRole;
  /** Où l'indice a été lu (fait T1 ou texte). */
  via?: 'fact' | 'text';
  /** Score / confiance associés (traçabilité, jamais un seuil ici). */
  score?: number | null;
  /** Libellé technique court (source du candidat, règle…) — jamais une valeur d'adresse. */
  detail?: string | null;
  /** Preuves sur lesquelles repose une décision IA ou d'identité. */
  support?: LinkProof[];
}

/** Étape décideuse (journal). */
export const ADMISSION_STEPS = [
  'T1_PROJECTION', 'T1_PRIMARY_COLUMN', 'T1_RULE_BRIDGE',
  'T3_DOCUMENT_ASSET', 'T3_ATTACHMENT_REVIEW', 'T3_FACT_TARGET', 'EQUIPMENT_LINK', 'REPAIR', 'OTHER',
] as const;
export type AdmissionStep = (typeof ADMISSION_STEPS)[number];

export interface LinkJustification {
  step: AdmissionStep;
  /** Règle appliquée par l'appelant (ex. `IDENTIFIER_EXACT:ADDRESS`, `MENTIONED_CANDIDATE`). */
  rule: string;
  proofs: LinkProof[];
}

export type AdmissionReason =
  | 'USER_DECISION'
  | 'PROOF'
  | 'ADDRESS_NOT_QUALIFIED'
  | 'NO_ADMISSIBLE_PROOF'
  | 'NO_JUSTIFICATION';

export interface AdmissionDecision {
  admitted: boolean;
  reasonCode: AdmissionReason;
  /** Preuve qui a emporté la décision (première admissible par ordre de force). */
  decisiveProof: LinkProof | null;
  /** Preuves écartées et pourquoi (journal). */
  rejected: Array<{ proof: LinkProof; why: 'ADDRESS_NOT_QUALIFIED' | 'CONTEXT_ONLY' | 'UNSUPPORTED_AI_DECISION' }>;
  version: number;
}

/** Ordre de force des preuves (la plus forte d'abord) pour désigner la preuve décisive. */
const FORCE: readonly LinkProofKind[] = [
  'USER_DECISION', 'KNOWN_TARGET', 'IDENTIFIER', 'FACT_TARGET', 'STRUCTURAL', 'SHARED_REFERENCE', 'IDENTITY_GROUP',
  'MODEL_DESIGNATION', 'DISTINCT_NAME', 'AI_REVIEW', 'AI_DECISION', 'CONTEXT',
];

/** Adresse dont le rôle n'est pas « lieu du bien » (pure). */
export function isUnqualifiedAddress(p: LinkProof): boolean {
  return p.kind === 'IDENTIFIER' && p.identifierKind === 'ADDRESS' && p.addressRole !== 'PROPERTY_LOCATION';
}

type Rejet = AdmissionDecision['rejected'][number]['why'];

/** Une preuve compte-t-elle ? `null` : oui ; sinon le motif du rejet (pure). */
function rejectionOf(p: LinkProof): Rejet | null {
  if (isUnqualifiedAddress(p)) return 'ADDRESS_NOT_QUALIFIED';
  if (p.kind === 'CONTEXT') return 'CONTEXT_ONLY';
  if (p.kind === 'AI_DECISION' || p.kind === 'AI_REVIEW' || p.kind === 'IDENTITY_GROUP') {
    // Une décision IA / d'identité doit reposer sur AUTRE CHOSE qu'une adresse non qualifiée (ni sur
    // le seul contexte qui en dérive : ville et code postal de cette adresse).
    const appui = p.support ?? [];
    if (p.kind === 'IDENTITY_GROUP' && appui.length === 0) return null;
    return appui.some((s) => !isAddressBasis(s) && (s.kind === 'CONTEXT' || rejectionOf(s) === null))
      ? null : 'UNSUPPORTED_AI_DECISION';
  }
  return null;
}

/** Adresse non qualifiée, ou contexte tiré d'une adresse (ville + code postal) : jamais un appui suffisant. */
function isAddressBasis(p: LinkProof): boolean {
  return isUnqualifiedAddress(p) || (p.kind === 'CONTEXT' && p.identifierKind === 'ADDRESS');
}

/** Une preuve (ou son appui) contient-elle une adresse non qualifiée ? */
function citesUnqualifiedAddress(p: LinkProof): boolean {
  return isAddressBasis(p) || (p.support ?? []).some(citesUnqualifiedAddress);
}

/**
 * LE prédicat partagé (pur). `origin` USER : décision de l'utilisateur,
 * toujours admise (jamais rejugée). Sinon : au moins une preuve admissible.
 */
export function admitDocumentAssetLink(
  origin: 'USER' | 'AI' | 'MIGRATION' | 'LEGACY_COLUMN',
  justification: LinkJustification | null | undefined,
): AdmissionDecision {
  const base = { rejected: [] as AdmissionDecision['rejected'], version: LINK_ADMISSION_VERSION };
  if (origin === 'USER') return { ...base, admitted: true, reasonCode: 'USER_DECISION', decisiveProof: { kind: 'USER_DECISION' } };
  if (!justification) return { ...base, admitted: false, reasonCode: 'NO_JUSTIFICATION', decisiveProof: null };
  const admises: LinkProof[] = [];
  for (const p of justification.proofs) {
    const why = rejectionOf(p);
    if (why) base.rejected.push({ proof: p, why });
    else admises.push(p);
  }
  if (admises.length > 0) {
    const decisive = [...admises].sort((a, b) => FORCE.indexOf(a.kind) - FORCE.indexOf(b.kind))[0];
    return { ...base, admitted: true, reasonCode: decisive.kind === 'USER_DECISION' || decisive.kind === 'KNOWN_TARGET' ? 'USER_DECISION' : 'PROOF', decisiveProof: decisive };
  }
  return {
    ...base, admitted: false, decisiveProof: null,
    reasonCode: justification.proofs.some(citesUnqualifiedAddress) ? 'ADDRESS_NOT_QUALIFIED' : 'NO_ADMISSIBLE_PROOF',
  };
}

/** Empreinte stable d'une justification (dédoublonnage du journal) — sans aucune valeur lue. */
export function justificationDigest(j: LinkJustification | null | undefined): string {
  const canon = (p: LinkProof): unknown => [p.kind, p.identifierKind ?? null, p.addressRole ?? null, p.via ?? null, p.detail ?? null, (p.support ?? []).map(canon)];
  return createHash('sha256').update(JSON.stringify(j ? [j.step, j.rule, j.proofs.map(canon)] : null)).digest('hex').slice(0, 32);
}

/** Justification d'un rattachement par une cible structurelle (équipement / pièce identifié). */
export function structuralJustification(step: AdmissionStep, rule: string, detail?: string | null, score?: number | null): LinkJustification {
  return { step, rule, proofs: [{ kind: 'STRUCTURAL', detail: detail ?? null, score: score ?? null }] };
}
