/**
 * Validation d'un CANDIDAT de retrieval — lot 101A (ticket « série d'un
 * équipement », point D). Module PUR.
 *
 * Ordre imposé : OBJET → PROPRIÉTÉ → SOURCE → VALEUR, AVANT toute
 * revalidation documentaire. La revalidation dit seulement « cette valeur
 * existe dans ce document » ; elle ne prouve pas qu'elle répond à la
 * question. Un candidat rejeté ici n'est jamais revalidé, jamais montré au
 * modèle, jamais réhabilité :
 *
 *   OTHER_OBJECT             le fait vise un AUTRE objet (autre équipement, le bien…) ;
 *   DOCUMENT_NOT_LINKED      fait sans cible d'un document non rattaché à l'objet ;
 *   PROPERTY_MISMATCH        le fait porte une autre propriété (numéro de série ≠ série) ;
 *   PROPERTY_UNKNOWN         propriété du fait non établie alors que la question
 *                            vise une propriété normalisée d'un objet résolu ;
 *   VALUE_TYPE_INCOMPATIBLE  la valeur n'a pas la forme de la propriété (un prix
 *                            pour un numéro de série, un VIN pour une série…).
 *
 * Générique : aucune règle propre au mot « série » — propriétés et formes de
 * valeur viennent du registre canonique et de `canonical/product-identity`.
 */
import { getField, resolveAlias } from '@/services/canonical/registry';
import { identityValueProblem, isProductIdentityKey } from '@/services/canonical/product-identity';
import { deterministicRequestedFacts } from '../canonical/field-vocabulary';
import type { FactHit } from './data-answer.service';

export type CandidateRejection =
  | 'OTHER_OBJECT' | 'DOCUMENT_NOT_LINKED' | 'PROPERTY_MISMATCH' | 'PROPERTY_UNKNOWN' | 'VALUE_TYPE_INCOMPATIBLE';

/** Objet métier visé par la question (résolu par le serveur). */
export interface CandidateObject {
  type: 'asset' | 'equipment' | 'room';
  id: number;
}

/** Verdict d'un candidat, tracé dans le diagnostic T2 (aucun contenu). */
export interface CandidateVerdict {
  factId: number;
  fileId: number;
  /** Objet source du candidat (cible du fait), si connu. */
  sourceObject: { type: string; id: number | null } | null;
  /** Propriété(s) source du candidat (clés du registre), si établies. */
  sourceProperty: string[];
  score: number;
  decision: 'KEPT' | 'REJECTED';
  /** Motif de sélection (`TARGET`, `LINKED_DOCUMENT`, `ACCOUNT_SCOPE`) ou de rejet. */
  reason: string;
}

type Candidate = Pick<FactHit, 'id' | 'fileId' | 'factKey' | 'attribute' | 'label' | 'valueText' | 'valueNumber' | 'valueUnit' | 'matchedTerms'
  | 'canonicalKey' | 'rawKey' | 'valueType' | 'targetType' | 'targetEntityId' | 'linkedToEntity' | 'assetId'>;

const ENTITE: Record<string, CandidateObject['type']> = { EQUIPMENT: 'equipment', ROOM: 'room', ASSET: 'asset' };

/** Propriétés du registre portées par un fait (pure, testée). */
export function propertiesOfFact(f: Pick<Candidate, 'canonicalKey' | 'rawKey' | 'factKey' | 'attribute' | 'label'>): string[] {
  if (f.canonicalKey && getField(f.canonicalKey)) return [f.canonicalKey];
  for (const brut of [f.rawKey, f.factKey]) {
    if (!brut) continue;
    if (getField(brut)) return [brut];
    const k = resolveAlias(brut);
    if (k) return [k];
  }
  for (const texte of [f.attribute, f.label]) {
    const ks = texte ? deterministicRequestedFacts(texte) : [];
    if (ks.length) return ks;
  }
  return [];
}

const libelle = (k: string) => (getField(k)?.label ?? k).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Deux propriétés désignent-elles la même chose (même clé, ou homonymes du registre) ? */
function memePropriete(a: string, b: string): boolean {
  return a === b || libelle(a) === libelle(b);
}

/** Valeur affichable d'un candidat. */
const valeurDe = (f: Pick<Candidate, 'valueText' | 'valueNumber' | 'valueUnit'>) =>
  f.valueText ?? (f.valueNumber != null ? `${f.valueNumber}${f.valueUnit ? ` ${f.valueUnit}` : ''}` : '');

const MONETAIRE = /^(eur|€|euros?|cents?)$/i;

/** La valeur du candidat a-t-elle la forme de la propriété demandée (pure) ? */
export function valueFitsProperty(key: string, f: Pick<Candidate, 'valueText' | 'valueNumber' | 'valueUnit' | 'valueType'>): boolean {
  const def = getField(key);
  if (!def) return true;
  const monetaire = (f.valueUnit && MONETAIRE.test(f.valueUnit.trim())) || /^money/.test(f.valueType ?? '');
  const attendMontant = def.valueType === 'money_eur' || def.valueType === 'money_cents';
  if (monetaire && !attendMontant && def.valueType !== 'number') return false;
  if (isProductIdentityKey(key) && identityValueProblem(key, valeurDe(f))) return false;
  return true;
}

/**
 * Verdict d'UN candidat (pure, testée) — objet, puis propriété, puis source,
 * puis valeur. `requestedFacts` : propriétés normalisées demandées (vides :
 * propriété non comprise, aucun filtre de propriété).
 */
export function validateFactCandidate(
  f: Candidate,
  ctx: { object: CandidateObject | null; requestedFacts: readonly string[]; score?: number },
): CandidateVerdict {
  const cible = f.targetType ? { type: f.targetType, id: f.targetEntityId ?? null } : null;
  const props = propertiesOfFact(f);
  const base = { factId: f.id, fileId: f.fileId, sourceObject: cible, sourceProperty: props, score: ctx.score ?? f.matchedTerms };
  const rejet = (reason: CandidateRejection): CandidateVerdict => ({ ...base, decision: 'REJECTED', reason });

  // 1. OBJET (et 3. SOURCE : un fait sans cible vaut par son document rattaché).
  let motif = 'ACCOUNT_SCOPE';
  const o = ctx.object;
  if (o && o.type !== 'asset') {
    const t = f.targetType ? ENTITE[f.targetType] : undefined;
    if (t && t === o.type && f.targetEntityId === o.id) motif = 'TARGET';
    else if (t) return rejet('OTHER_OBJECT');
    else if (f.linkedToEntity) motif = 'LINKED_DOCUMENT';
    else return rejet('DOCUMENT_NOT_LINKED');
  } else if (o && o.type === 'asset') {
    if (f.targetType === 'ASSET' && f.targetEntityId != null && f.targetEntityId !== o.id) return rejet('OTHER_OBJECT');
    motif = 'ASSET_SCOPE';
  }

  // 2. PROPRIÉTÉ.
  const demandes = ctx.requestedFacts;
  if (demandes.length) {
    if (props.length && !props.some((p) => demandes.some((d) => memePropriete(p, d)))) return rejet('PROPERTY_MISMATCH');
    // Propriété du fait inconnue : refusée dès que la question est bornée à un
    // objet ou vise l'identité d'un produit (aucune valeur « qui contient le mot »).
    if (!props.length && ((o && o.type !== 'asset') || demandes.some(isProductIdentityKey))) return rejet('PROPERTY_UNKNOWN');
    // 4. VALEUR : forme compatible avec la propriété demandée.
    const cle = props.find((p) => demandes.some((d) => memePropriete(p, d))) ?? demandes[0];
    const cleDemandee = demandes.find((d) => memePropriete(cle, d)) ?? cle;
    if (!valueFitsProperty(cleDemandee, f)) return rejet('VALUE_TYPE_INCOMPATIBLE');
  } else if (props.some(isProductIdentityKey) && !valueFitsProperty(props.find(isProductIdentityKey)!, f)) {
    return rejet('VALUE_TYPE_INCOMPATIBLE');
  }
  return { ...base, decision: 'KEPT', reason: motif };
}
