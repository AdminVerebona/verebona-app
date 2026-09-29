/**
 * Accès au registre canonique : lecture, résolution d'alias, DTO pour prompts.
 *
 * Résolution d'une clé brute (`resolveAlias`) :
 *   1. la comparaison ignore casse, accents, `_`, `-` et espaces
 *      (`purchase_date` ≡ `purchaseDate`, `kilométrage` ≡ `kilometrage`) ;
 *   2. une clé canonique applicable à la famille l'emporte sur un alias ;
 *   3. un alias n'est résolu que dans les familles du champ qui le déclare ;
 *   4. sans famille, une forme qui désigne plusieurs clés n'est PAS résolue
 *      (ex. `loyerMensuel` : loyer d'un logement ou mensualité de LOA) ;
 *   5. les clés exclues (EXCLUDED_KEYS) et les origines `*_origin` ne sont
 *      jamais résolues.
 */
import { CANONICAL_FIELDS, EXCLUDED_KEYS, REGISTRY_VERSION } from './fields';
import { EVENT_CATALOG, DOCUMENT_CATALOG } from './catalogs';
import type {
  AliasResolution,
  AssetFamily,
  CanonicalFieldDef,
  CanonicalTargetType,
  ExcludedKey,
  PromptCatalogDTO,
} from './types';

/** Forme de comparaison d'une clé brute. */
export function aliasToken(raw: string): string {
  return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BY_KEY = new Map<string, CanonicalFieldDef>(CANONICAL_FIELDS.map((d) => [d.key, d]));
const EXCLUDED_BY_TOKEN = new Map<string, ExcludedKey>(EXCLUDED_KEYS.map((e) => [aliasToken(e.key), e]));

interface Entree { def: CanonicalFieldDef; canonical: boolean; alias?: string }
const BY_TOKEN = new Map<string, Entree[]>();
for (const def of CANONICAL_FIELDS) {
  const push = (raw: string, canonical: boolean) => {
    const t = aliasToken(raw);
    const list = BY_TOKEN.get(t) ?? [];
    if (!list.some((e) => e.def === def)) list.push({ def, canonical, alias: canonical ? undefined : raw });
    BY_TOKEN.set(t, list);
  };
  push(def.key, true);
  for (const a of def.aliases) push(a, false);
}

/**
 * Famille de bien depuis `assets.category` ou un code historique.
 * `OBJET` (assistant), `MATERIEL_PRO` et `AUTRE` → `OBJECT`, comme la fiche.
 */
export function toAssetFamily(category: string | null | undefined): AssetFamily | undefined {
  if (!category) return undefined;
  const c = category.toUpperCase();
  if (c === 'IMMOBILIER' || c === 'VEHICULE') return c;
  if (c === 'OBJECT' || c === 'OBJET' || c === 'MATERIEL_PRO' || c === 'AUTRE') return 'OBJECT';
  return undefined;
}

/** Définition d'une clé CANONIQUE (pas d'alias). */
export function getField(key: string): CanonicalFieldDef | undefined {
  return BY_KEY.get(key);
}

/** Cibles admises d'un champ (`['ASSET']` par défaut) — lot 13, T1-04. */
export function fieldTargetTypes(def: CanonicalFieldDef): CanonicalTargetType[] {
  return def.targetTypes?.length ? [...def.targetTypes] : [def.targetType ?? 'ASSET'];
}

/**
 * Champs applicables à une famille (tous sans famille), dans l'ordre du
 * registre. Par défaut, les champs d'un BIEN seulement (`targetType: 'ASSET'`) :
 * la fiche, `CanonicalAssetView` et les miroirs ne voient jamais un champ de
 * pièce (`roomArea`). `targetType` : champs admettant cette cible.
 */
export function listFields(family?: AssetFamily, opts: { targetType?: CanonicalTargetType } = {}): CanonicalFieldDef[] {
  const cible = opts.targetType ?? 'ASSET';
  return CANONICAL_FIELDS.filter((d) => fieldTargetTypes(d).includes(cible) && (!family || d.families.includes(family)));
}

/** Motif de l'exclusion d'une clé brute, s'il y en a une. */
export function isExcludedKey(rawKey: string): ExcludedKey | undefined {
  if (/_origin$/.test(rawKey)) return { key: rawKey, kind: 'TECHNICAL', reason: 'Origine de valeur (fieldKey_origin / fieldKey__origin).' };
  return EXCLUDED_BY_TOKEN.get(aliasToken(rawKey));
}

/** Résolution détaillée : clé canonique et unité portée par la clé brute. */
export function resolveAliasDetailed(rawKey: string, family?: AssetFamily): AliasResolution | undefined {
  if (!rawKey || isExcludedKey(rawKey)) return undefined;
  const entrees = BY_TOKEN.get(aliasToken(rawKey));
  if (!entrees?.length) return undefined;
  const applicables = family ? entrees.filter((e) => e.def.families.includes(family)) : entrees;
  const canoniques = applicables.filter((e) => e.canonical);
  const retenues = canoniques.length ? canoniques : applicables;
  if (retenues.length !== 1) return undefined;
  const { def, canonical, alias } = retenues[0];
  const sourceUnit = alias ? def.aliasUnits?.[alias] : undefined;
  return { key: def.key, canonical, ...(sourceUnit ? { sourceUnit } : {}) };
}

/** Clé brute → clé canonique (voir règles en tête de fichier). */
export function resolveAlias(rawKey: string, family?: AssetFamily): string | undefined {
  return resolveAliasDetailed(rawKey, family)?.key;
}

/**
 * Catalogue sérialisable transmis aux prompts (R6) : données structurées,
 * jamais du texte de règles. Filtré par famille si fournie.
 */
export function catalogForPrompts(opts: { family?: AssetFamily } = {}): PromptCatalogDTO {
  const { family } = opts;
  const pourFamille = <T extends { families: AssetFamily[] }>(x: T) => !family || x.families.includes(family);
  // Cibles dans le contexte : le BIEN si le champ s'applique à sa famille,
  // l'ÉQUIPEMENT ou la PIÈCE si déclarés (un bien de toute famille peut
  // avoir des équipements ; les pièces restent limitées aux familles du champ).
  const fields = CANONICAL_FIELDS.flatMap((d) => {
    const dansFamille = !family || d.families.includes(family);
    const targets = fieldTargetTypes(d).filter((t) => (t === 'ASSET' || t === 'ROOM' ? dansFamille : true));
    if (targets.length === 0) return [];
    return [{
      key: d.key,
      label: d.label,
      valueType: d.valueType,
      ...(d.unit ? { unit: d.unit } : {}),
      ...(d.enumValues ? { enumValues: [...d.enumValues] } : {}),
      ...(d.agendaEffect ? { agenda: { nature: d.agendaEffect.nature, businessType: d.agendaEffect.businessType } } : {}),
      assistantWritable: d.assistantWritable,
      targets,
    }];
  });
  const keys = new Set(fields.map((x) => x.key));
  const events = EVENT_CATALOG.filter(pourFamille).map((e) => ({
    businessType: e.businessType,
    label: e.label,
    natures: [...e.natures],
    fieldKeys: e.fieldKeys.filter((k) => keys.has(k)),
  }));
  const documents = DOCUMENT_CATALOG.filter(pourFamille).map((d) => ({
    code: d.code,
    label: d.label,
    authority: d.authority,
    mayCreateAgenda: d.mayCreateAgenda,
    businessTypes: [...d.businessTypes],
    completionProofs: d.completionProofs.map((p) => ({ code: p.code, description: p.description, establishes: p.establishes })),
  }));
  return { version: REGISTRY_VERSION, family: family ?? null, fields, events, documents };
}
