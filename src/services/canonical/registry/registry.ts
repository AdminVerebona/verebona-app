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
 *      jamais résolues ;
 *   6. un alias CONTEXTUEL (`CONTEXTUAL_ALIASES`, décisions PO D-C / D-D)
 *      dépend du type documentaire passé en contexte (`dateFinContrat`,
 *      `numeroContrat`, `dateEtablissement`) ; sans contexte, sa branche
 *      générale (résolution historique inchangée).
 */
import { toAssetFamilyCode } from '@/lib/asset-taxonomy';
import { assetHasRegistration } from '@/lib/asset-capabilities';
import { CANONICAL_FIELDS, CONTEXTUAL_ALIASES, EXCLUDED_KEYS, REGISTRY_VERSION } from './fields';
import { EVENT_CATALOG, DOCUMENT_CATALOG, resolveDocumentType } from './catalogs';
import {
  ASSET_FAMILY_CODES,
  type AliasResolution,
  type AssetFamily,
  type CanonicalFieldDef,
  type CanonicalTargetType,
  type ExcludedKey,
  type PromptCatalogDTO,
  type T2ReadCatalogDTO,
  type T2ReadFieldDTO,
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
 * Résolveur UNIQUE : `toAssetFamilyCode` de `lib/asset-taxonomy` (lot 30) —
 * aucun consommateur ne reconstruit cette équivalence.
 */
export function toAssetFamily(category: string | null | undefined): AssetFamily | undefined {
  return toAssetFamilyCode(category);
}

/** Définition d'une clé CANONIQUE (pas d'alias). */
export function getField(key: string): CanonicalFieldDef | undefined {
  // Index construit au chargement ; repli sur le registre (champ ajouté depuis).
  return BY_KEY.get(key) ?? CANONICAL_FIELDS.find((d) => d.key === key);
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

/**
 * Le champ s'applique-t-il à CE bien ? (lot 32, L32-1) — famille du bien,
 * puis capacité de catégorie (`requiresCapability`) : l'immatriculation ne
 * s'applique pas à un vélo. Clé brute ou alias acceptés ; clé inconnue :
 * `true` (rien n'est présumé, les autres contrôles s'appliquent).
 */
export function isFieldApplicableToAsset(
  rawKey: string,
  asset: { category: string | null | undefined; subtype?: string | null },
): boolean {
  const family = toAssetFamilyCode(asset.category);
  const key = resolveAlias(rawKey, family) ?? rawKey;
  const def = getField(key);
  if (!def) return true;
  if (family && !def.families.includes(family)) return false;
  if (def.requiresCapability === 'registration') {
    return assetHasRegistration({ category: asset.category ?? '', subtype: asset.subtype ?? null });
  }
  return true;
}

/** Motif de l'exclusion d'une clé brute, s'il y en a une. */
export function isExcludedKey(rawKey: string): ExcludedKey | undefined {
  if (/_origin$/.test(rawKey)) return { key: rawKey, kind: 'TECHNICAL', reason: 'Origine de valeur (fieldKey_origin / fieldKey__origin).' };
  return EXCLUDED_BY_TOKEN.get(aliasToken(rawKey));
}

/** Contexte documentaire d'une résolution (décisions PO D-C / D-D, lot 20). */
export interface AliasContext {
  /** Type documentaire : code DOCUMENT_CATALOG, alias, code V2 ou libre. */
  documentType?: string | null;
  /**
   * Cible du fait. Pour un ÉQUIPEMENT ou une PIÈCE, seuls les champs qui
   * admettent cette cible sont candidats et la famille du bien porteur ne
   * filtre pas (comme `catalogForPrompts`) : la puissance d'une PAC de maison
   * se résout en `powerKw` même si le champ n'est « de bien » que pour un véhicule.
   */
  targetType?: CanonicalTargetType | string | null;
}

/** Cible d'entité (équipement, pièce) : la famille du bien ne s'applique pas. */
const cibleEntite = (ctx: AliasContext | undefined): 'EQUIPMENT' | 'ROOM' | null =>
  (ctx?.targetType === 'EQUIPMENT' || ctx?.targetType === 'ROOM' ? ctx.targetType : null);

const CONTEXTUAL_BY_TOKEN = new Map(Object.entries(CONTEXTUAL_ALIASES).map(([k, v]) => [aliasToken(k), v]));

/** Le jeton désigne-t-il un alias contextuel (`dateFinContrat`…) ? */
export function isContextualAlias(rawKey: string): boolean {
  return !!rawKey && CONTEXTUAL_BY_TOKEN.has(aliasToken(rawKey));
}

const LEASE_CODE = /(^|_)(BAIL|BAUX|LEASE|LEASING|LOCATION|LOA|LLD|RENTAL)(_|$)/;
const INSURANCE_CODE = /(^|_)(ASSURANCE|INSURANCE)(_|$)/;
const DIAGNOSTIC_CODE = /(^|_)DIAGNOSTIC(_|$)/;

/**
 * Nature documentaire utile aux alias contextuels (pure) : par le catalogue
 * (types d'événement du type), sinon par le code lui-même (codes V2 ou
 * libres : `RESIDENTIAL_LEASE`, `INSURANCE_POLICY`…). Un type inconnu ou
 * absent : aucune nature (branche générale).
 */
export function documentContextOf(documentType: string | null | undefined): {
  lease: boolean; insurance: boolean; dpe: boolean; diagnostic: boolean;
} {
  const code = (documentType ?? '').trim().toUpperCase();
  if (!code) return { lease: false, insurance: false, dpe: false, diagnostic: false };
  const entry = resolveDocumentType(code);
  if (entry) {
    // Type catalogué : le catalogue seul fait foi.
    const types: readonly string[] = entry.businessTypes;
    return {
      lease: types.includes('lease'),
      insurance: types.includes('insurance'),
      dpe: entry.code === 'DPE',
      diagnostic: entry.code === 'DIAGNOSTIC',
    };
  }
  return {
    lease: LEASE_CODE.test(code),
    insurance: INSURANCE_CODE.test(code),
    dpe: code === 'DPE',
    diagnostic: DIAGNOSTIC_CODE.test(code),
  };
}

/**
 * Alias contextuel : clé retenue selon le type documentaire, puis la famille
 * (une clé inapplicable à la famille retombe sur la branche générale).
 * `null` : le jeton n'est pas contextuel ; `undefined` : non résolu.
 */
function resolveContextual(rawKey: string, family: AssetFamily | undefined, ctx: AliasContext | undefined): AliasResolution | undefined | null {
  const regle = CONTEXTUAL_BY_TOKEN.get(aliasToken(rawKey));
  if (!regle) return null;
  const d = documentContextOf(ctx?.documentType);
  const candidates = [
    d.lease ? regle.lease : undefined,
    d.insurance ? regle.insurance : undefined,
    d.dpe ? regle.dpe : undefined,
    d.diagnostic ? regle.diagnostic : undefined,
    regle.otherwise,
  ].filter((k): k is string => typeof k === 'string');
  const entite = cibleEntite(ctx);
  for (const k of candidates) {
    const def = BY_KEY.get(k);
    if (!def) continue;
    if (entite ? fieldTargetTypes(def).includes(entite) : (!family || def.families.includes(family))) return { key: def.key, canonical: false };
  }
  return undefined;
}

/**
 * Résolution détaillée : clé canonique et unité portée par la clé brute.
 * `ctx.documentType` : alias dont la clé dépend du document (règle 6).
 */
export function resolveAliasDetailed(rawKey: string, family?: AssetFamily, ctx?: AliasContext): AliasResolution | undefined {
  if (!rawKey || isExcludedKey(rawKey)) return undefined;
  const contextuelle = resolveContextual(rawKey, family, ctx);
  if (contextuelle !== null) return contextuelle;
  const entrees = BY_TOKEN.get(aliasToken(rawKey));
  if (!entrees?.length) return undefined;
  const entite = cibleEntite(ctx);
  const applicables = entite
    ? entrees.filter((e) => fieldTargetTypes(e.def).includes(entite))
    : family ? entrees.filter((e) => e.def.families.includes(family)) : entrees;
  const canoniques = applicables.filter((e) => e.canonical);
  const retenues = canoniques.length ? canoniques : applicables;
  if (retenues.length !== 1) return undefined;
  const { def, canonical, alias } = retenues[0];
  const sourceUnit = alias ? def.aliasUnits?.[alias] : undefined;
  return { key: def.key, canonical, ...(sourceUnit ? { sourceUnit } : {}) };
}

/** Clé brute → clé canonique (voir règles en tête de fichier) ; `ctx` : type documentaire (règle 6). */
export function resolveAlias(rawKey: string, family?: AssetFamily, ctx?: AliasContext): string | undefined {
  return resolveAliasDetailed(rawKey, family, ctx)?.key;
}

/**
 * Clé de SAISIE UNIQUEMENT (`inputOnly`, décision PO D-D) : la clé
 * canonique, ou un alias qui y mène dans au moins une famille. Jamais
 * inférée par l'IA : ni projetée, ni prouvée, ni appliquée par T3.
 */
export function isInputOnlyKey(rawKey: string | null | undefined): boolean {
  if (!rawKey || isExcludedKey(rawKey)) return false;
  if (BY_KEY.get(rawKey)?.inputOnly) return true;
  const keys = new Set<string | undefined>([resolveAlias(rawKey), ...ASSET_FAMILY_CODES.map((f) => resolveAlias(rawKey, f))]);
  return [...keys].some((k) => !!k && BY_KEY.get(k)?.inputOnly === true);
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
    // D-D : un champ de saisie seule n'est jamais demandé au modèle.
    if (d.inputOnly) return [];
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

/** Forme d'une formulation : minuscules, sans accent, apostrophe droite, espaces simples. */
const formulation = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Vocabulaire OFFICIEL d'un champ pour l'assistant (AC20) : libellé puis
 * `assistantPhrases`, normalisés et dédoublonnés. Les `aliases` — clés
 * techniques ou historiques (`purchasePriceCents`, `date_achat`) — n'en font
 * jamais partie : ils ne sont pas des formulations utilisateur.
 */
export function fieldAssistantVocabulary(def: Pick<CanonicalFieldDef, 'label' | 'assistantPhrases'>): string[] {
  return [...new Set([def.label, ...(def.assistantPhrases ?? [])].map(formulation).filter(Boolean))];
}

/**
 * Projection OFFICIELLE du registre pour la LECTURE T2 (lot 30, AC19) :
 * source unique du FIELD_CATALOG de UNDERSTAND (`describeFieldCatalog`) et
 * du matcher déterministe (`field-vocabulary`). Règles propres à la lecture :
 *   · `assistantReadable` seulement ; une clé une fois (ordre du registre) ;
 *   · toutes cibles et familles déclarées (la famille du bien est connue
 *     après résolution de la cible, pas avant) ;
 *   · `inputOnly` N'EST PAS un motif d'exclusion (règle d'inférence T1, pas
 *     de lecture) ; `sensitive` non plus (lecture de sa propre donnée, 8a §A) ;
 *   · type, unité, valeurs et libellés d'enum repris tels quels du registre.
 * Calculée à chaque appel (aucune copie figée du registre).
 * Différente de `catalogForPrompts` (inférence T1 : `inputOnly` exclu, cibles
 * filtrées par famille, agenda).
 */
export function catalogForT2Read(): T2ReadCatalogDTO {
  const vus = new Set<string>();
  const fields: T2ReadFieldDTO[] = [];
  for (const d of CANONICAL_FIELDS) {
    if (!d.assistantReadable || vus.has(d.key)) continue;
    vus.add(d.key);
    fields.push({
      key: d.key,
      label: d.label,
      families: [...d.families],
      targets: fieldTargetTypes(d),
      valueType: d.valueType,
      ...(d.unit ? { unit: d.unit } : {}),
      ...(d.enumValues ? { enumValues: [...d.enumValues] } : {}),
      ...(d.enumLabels ? { enumLabels: { ...d.enumLabels } } : {}),
      sensitive: d.sensitive === true,
      phrases: fieldAssistantVocabulary(d),
    });
  }
  return { version: REGISTRY_VERSION, fields };
}
