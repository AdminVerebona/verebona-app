/**
 * Lot 88B — propriétés canoniques CANDIDATES d'un objet (partie PURE).
 *
 * Aucune liste codée : le catalogue est celui du REGISTRE CANONIQUE (celui
 * de l'onglet « Informations », des miroirs et des lecteurs canoniques) —
 * `listFields(famille)` pour un bien (capacité de catégorie comprise),
 * `listEntityFields('EQUIPMENT')` pour un équipement. Seuls des DRAPEAUX DU
 * REGISTRE écartent une clé, chacun pour une raison déclarée :
 *   · NOT_APPLICABLE  hors famille / capacité de la catégorie ;
 *   · INPUT_ONLY      saisie seule (D-D) : jamais écrite automatiquement ;
 *   · FREE_TEXT       texte libre (description, notes) : jamais composé ;
 *   · SENSITIVE       donnée personnelle : jamais transmise au modèle ;
 *   · STRUCTURED_JSON valeur composée (json) : non établissable par une citation.
 * Une propriété RENSEIGNÉE n'est jamais candidate. Une propriété VIDE dont
 * l'utilisateur a corrigé l'état (valeur effacée, décision de carte) est
 * PROTÉGÉE : jamais soumise, jamais écrite.
 */
import { isFieldApplicableToAsset, listFields, toAssetFamily, type CanonicalFieldDef } from '@/services/canonical/registry';
import { questionValueType, type PropertyQuestion, type SubjectType } from './contract';

export type ExclusionReason = 'NOT_APPLICABLE' | 'INPUT_ONLY' | 'FREE_TEXT' | 'SENSITIVE' | 'STRUCTURED_JSON';
export type ProtectionReason = 'USER_CLEARED' | 'USER_DECISION' | 'OPEN_ARBITRATION';

export interface CatalogSubject {
  type: SubjectType;
  category: string | null;
  subtype: string | null;
}

/** Définitions du registre applicables à l'objet (avant exclusions). Pure. */
export function registryDefinitions(s: CatalogSubject): CanonicalFieldDef[] {
  if (s.type === 'EQUIPMENT') return listFields(undefined, { targetType: 'EQUIPMENT' });
  return listFields(toAssetFamily(s.category) ?? 'OBJECT');
}

/** Motif d'exclusion déclaré d'une définition (drapeaux du registre seulement), ou null. Pure. */
export function exclusionOf(def: CanonicalFieldDef, s: CatalogSubject): ExclusionReason | null {
  if (s.type === 'ASSET' && !isFieldApplicableToAsset(def.key, { category: s.category, subtype: s.subtype })) return 'NOT_APPLICABLE';
  if (def.inputOnly) return 'INPUT_ONLY';
  if (def.freeText) return 'FREE_TEXT';
  if (def.sensitive) return 'SENSITIVE';
  if (def.valueType === 'json') return 'STRUCTURED_JSON';
  return null;
}

export interface CatalogInput {
  subject: CatalogSubject;
  /** Valeur canonique courante (lecteur canonique : fiche, alias, miroir), null si vide. */
  current: (key: string) => unknown;
  /** Protections calculées (corrections et décisions de l'utilisateur, arbitrage en cours). */
  protections: ReadonlyMap<string, ProtectionReason>;
}

export interface MissingPropertyCatalog {
  /** Propriétés vides, soumissibles. */
  missing: PropertyQuestion[];
  /** Propriétés vides protégées (jamais soumises, jamais écrites). */
  protectedKeys: Array<{ key: string; reason: ProtectionReason }>;
  /** Clés écartées par un drapeau du registre (décompte par motif). */
  excluded: Record<ExclusionReason, number>;
  /** Propriétés renseignées (jamais candidates). */
  filled: number;
}

const vide = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Question d'une définition du registre (pure). */
export function questionOf(def: CanonicalFieldDef): PropertyQuestion {
  return {
    key: def.key, label: def.label, valueType: questionValueType(def.valueType), registryType: def.valueType,
    unit: def.unit ?? null, enumValues: def.valueType === 'enum' && def.enumValues?.length ? [...def.enumValues] : null,
  };
}

/** Inventaire des propriétés manquantes d'un objet (pure, ordre du registre). */
export function missingPropertyCatalog(i: CatalogInput): MissingPropertyCatalog {
  const out: MissingPropertyCatalog = {
    missing: [], protectedKeys: [], filled: 0,
    excluded: { NOT_APPLICABLE: 0, INPUT_ONLY: 0, FREE_TEXT: 0, SENSITIVE: 0, STRUCTURED_JSON: 0 },
  };
  for (const def of registryDefinitions(i.subject)) {
    const ex = exclusionOf(def, i.subject);
    if (ex) { out.excluded[ex] += 1; continue; }
    if (!vide(i.current(def.key))) { out.filled += 1; continue; }
    const p = i.protections.get(def.key);
    if (p) { out.protectedKeys.push({ key: def.key, reason: p }); continue; }
    out.missing.push(questionOf(def));
  }
  return out;
}
