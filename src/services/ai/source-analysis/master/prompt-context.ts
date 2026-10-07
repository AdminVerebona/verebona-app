/**
 * Variables structurées du prompt maître T1 — CDC 15 §23 (DONNÉES FOURNIES
 * PAR LE SERVEUR), §22.2 (« les référentiels sont transmis sous forme de
 * données structurées et restent la source de vérité du code »), T1-01.
 *
 * Fonctions PURES : aucune lecture en base. Le contexte d'entités est celui,
 * déjà borné, de `AnalysisContext` (§5.6 : identifiants et libellés, jamais la
 * sérialisation complète des enregistrements).
 *
 * Le prompt-loader refuse toute variable sans emplacement et tout emplacement
 * sans valeur : chaque branche fournit donc EXACTEMENT les variables
 * ci-dessous (TASK est fixée par le serveur, jamais par l'appelant).
 *
 * CAPACITÉS DU COMPTE (Pièces, Équipements) : T1 reçoit les capacités
 * effectives (`ACCOUNT_CAPABILITIES`), jamais le nom de l'offre. Sans la
 * capacité, ENTITY_CONTEXT ne transmet aucune pièce / aucun équipement et
 * FIELD_CATALOG retire la cible correspondante (un champ sans cible restante
 * n'est pas transmis). Le registre canonique, lui, n'est jamais modifié.
 */
import {
  catalogForPrompts,
  toAssetFamily,
  type AssetFamily,
} from '@/services/canonical/registry';
import {
  buildPromptReferential,
  getVisibleRubrics,
  REFERENTIAL_VERSION,
  type AssetFamily as V2AssetFamily,
} from '@/lib/referential/v2';
import type { AnalysisContext, SourceInput } from '../types';
import { promptIdentifiers } from '../../reconciliation/document-asset/identifiers';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { PromptCatalogDTO } from '@/services/canonical/registry/types';

/** Emplacements du master `t1_master_v1` (hors `{{TASK}}`). */
export const T1_PROMPT_VARIABLES = [
  'SOURCES', 'ENTITY_CONTEXT', 'KNOWN_TARGET', 'FIELD_CATALOG',
  'EVENT_CATALOG', 'DOCUMENT_CATALOG', 'EXISTING_TITLES', 'EXTRACTED_CONTENT',
  'ACCOUNT_CAPABILITIES',
] as const;
export type T1PromptVariables = Record<(typeof T1_PROMPT_VARIABLES)[number], string>;

/** Bornes du contexte (mêmes ordres de grandeur que les étapes historiques). */
const MAX_ASSETS = 60;
const MAX_ROOMS = 80;
const MAX_EQUIPMENTS = 80;
const MAX_TITLES = 50;

const NON_UTILISE = '(non utilisé pour cette branche)';

/** Famille canonique du bien choisi par l'utilisateur, s'il y en a un. */
export function knownTargetFamily(ctx: AnalysisContext): AssetFamily | undefined {
  if (!ctx.linkedAssetId) return undefined;
  return toAssetFamily(ctx.assets.find((a) => a.id === ctx.linkedAssetId)?.category);
}

/** Liste des fichiers du groupe, indexés dans l'ordre des pièces jointes. */
export function describeSources(input: SourceInput, indices: number[]): string {
  return JSON.stringify(indices.map((i, position) => ({
    index: position,
    name: input.displayNames[i] ?? `source ${position + 1}`,
    mimeType: input.mimeTypes[i] ?? null,
    kind: input.sourceType === 'web_link' ? 'page web' : 'document',
  })));
}

/**
 * ENTITY_CONTEXT : identifiants et libellés bornés. Sans la capacité, aucune
 * pièce / aucun équipement (le modèle ne reçoit jamais leurs identifiants).
 *
 * Lot 31B (ticket T1, cause 1) : chaque bien porte en plus ses identifiants
 * canoniques DISCRIMINANTS, selon sa famille (code postal, ville, référence
 * cadastrale ; immatriculation, VIN, marque, modèle ; n° de série, marque,
 * modèle) — jamais la fiche entière, jamais un champ `sensitive` du
 * registre (l'adresse : sa correspondance est faite côté serveur, voir
 * `document-asset/identifiers.ts`). Les clés absentes ne sont pas émises.
 */
export function describeEntities(ctx: AnalysisContext, caps: AccountCapabilities): string {
  const identifiers = new Map((ctx.assetIdentifiers ?? []).map((r) => [r.assetId, r]));
  return JSON.stringify({
    assets: ctx.assets.slice(0, MAX_ASSETS).map((a) => ({
      id: a.id, name: a.name, family: toAssetFamily(a.category) ?? null, subtype: a.subtype ?? null,
      ...promptIdentifiers(identifiers.get(a.id)),
    })),
    rooms: caps.rooms ? ctx.rooms.slice(0, MAX_ROOMS).map((r) => ({ id: r.id, name: r.name, assetId: r.assetId })) : [],
    equipments: caps.equipments
      ? ctx.equipments.slice(0, MAX_EQUIPMENTS).map((e) => ({ id: e.id, name: e.name, type: e.type ?? null, assetId: e.assetId }))
      : [],
  });
}

/**
 * FIELD_CATALOG selon les capacités : cibles ROOM / EQUIPMENT retirées sans la
 * capacité ; un champ sans cible restante n'est pas transmis ; les clés
 * d'événement suivent. Rend aussi le nombre de champs retirés (trace).
 */
export function catalogForCapabilities(
  catalog: PromptCatalogDTO,
  caps: AccountCapabilities,
): { catalog: PromptCatalogDTO; fieldsFiltered: number } {
  const fields = catalog.fields.flatMap((f) => {
    const targets = f.targets.filter((t) => (t === 'ROOM' ? caps.rooms : t === 'EQUIPMENT' ? caps.equipments : true));
    return targets.length ? [{ ...f, targets }] : [];
  });
  const keys = new Set(fields.map((f) => f.key));
  return {
    catalog: { ...catalog, fields, events: catalog.events.map((e) => ({ ...e, fieldKeys: e.fieldKeys.filter((k) => keys.has(k)) })) },
    fieldsFiltered: catalog.fields.length - fields.length,
  };
}

/** Compteurs de filtrage du contexte (trace T1, aucune valeur métier). */
export function contextFilterStats(ctx: AnalysisContext, caps: AccountCapabilities) {
  return {
    roomsFilteredFromContext: caps.rooms ? 0 : Math.min(ctx.rooms.length, MAX_ROOMS),
    equipmentsFilteredFromContext: caps.equipments ? 0 : Math.min(ctx.equipments.length, MAX_EQUIPMENTS),
  };
}

/** KNOWN_TARGET : le bien choisi explicitement au dépôt, ou `null`. */
export function describeKnownTarget(ctx: AnalysisContext): string {
  if (!ctx.linkedAssetId) return 'null';
  const a = ctx.assets.find((x) => x.id === ctx.linkedAssetId);
  return JSON.stringify({
    type: 'ASSET',
    entityId: ctx.linkedAssetId,
    name: a?.name ?? null,
    family: toAssetFamily(a?.category) ?? null,
  });
}

/**
 * DOCUMENT_CATALOG : types canoniques (autorité, preuves d'exécution) et
 * rubriques / types V2 applicables. Les Types « Autre » ne sont pas transmis
 * (`buildPromptReferential` les retire : V2 §11.4, DOC-08).
 */
export function describeDocumentCatalog(
  documents: ReturnType<typeof catalogForPrompts>['documents'],
  v2Families: V2AssetFamily[],
): string {
  const applicable = new Set(getVisibleRubrics({
    families: v2Families, hasRentedAsset: true, hasRentalDocuments: true,
  }).map((r) => r.code));
  const referential = buildPromptReferential();
  return JSON.stringify({
    canonicalTypes: documents,
    rubricsVersion: REFERENTIAL_VERSION,
    rubrics: referential.rubrics
      .filter((r) => applicable.has(r.code))
      .map((r) => ({
        code: r.code,
        label: r.label,
        purpose: r.purpose,
        exclusions: r.exclusions,
        types: r.types
          .filter((t) => v2Families.length === 0 || t.applicability.some((f) => v2Families.includes(f)))
          .map((t) => ({ code: t.code, label: t.label, purpose: t.purpose })),
      })),
  });
}

/** Variables de la branche ANALYZE_DOCUMENT. */
export function buildAnalyzeDocumentVariables(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  /** Familles V2 des biens connus (vide : toutes). */
  v2Families: V2AssetFamily[];
  /** Capacités effectives du compte (résolues côté serveur). */
  capabilities: AccountCapabilities;
}): T1PromptVariables {
  // T1-01 : registre canonique filtré par la famille du bien connu ; sans
  // bien connu, le registre complet (le modèle ne sait pas encore la cible).
  // Puis filtré par les capacités du compte (cibles ROOM / EQUIPMENT).
  const { catalog } = catalogForCapabilities(catalogForPrompts({ family: knownTargetFamily(p.ctx) }), p.capabilities);
  return {
    SOURCES: describeSources(p.input, p.groupIndices),
    ENTITY_CONTEXT: describeEntities(p.ctx, p.capabilities),
    KNOWN_TARGET: describeKnownTarget(p.ctx),
    FIELD_CATALOG: JSON.stringify({ version: catalog.version, family: catalog.family, fields: catalog.fields }),
    EVENT_CATALOG: JSON.stringify(catalog.events),
    DOCUMENT_CATALOG: describeDocumentCatalog(catalog.documents, p.v2Families),
    EXISTING_TITLES: JSON.stringify(p.ctx.existingTitles.slice(0, MAX_TITLES)),
    // Donnée DÉLIMITÉE (chaîne JSON) : un contenu de page web ne peut pas se
    // faire passer pour une consigne du master (injection).
    EXTRACTED_CONTENT: JSON.stringify(p.input.extractedContent ?? ''),
    // Capacités effectives, jamais le nom de l'offre.
    ACCOUNT_CAPABILITIES: JSON.stringify({ rooms: p.capabilities.rooms, equipments: p.capabilities.equipments }),
  };
}

/**
 * Variables de la branche GROUP_UPLOAD : seules les sources servent ; les
 * autres emplacements reçoivent une valeur explicite (jamais de `{{X}}` au
 * modèle, jamais de référentiel inutile facturé en jetons).
 */
export function buildGroupUploadVariables(input: SourceInput): T1PromptVariables {
  return {
    SOURCES: describeSources(input, input.sourceIds.map((_, i) => i)),
    ENTITY_CONTEXT: NON_UTILISE,
    KNOWN_TARGET: NON_UTILISE,
    FIELD_CATALOG: NON_UTILISE,
    EVENT_CATALOG: NON_UTILISE,
    DOCUMENT_CATALOG: NON_UTILISE,
    EXISTING_TITLES: NON_UTILISE,
    EXTRACTED_CONTENT: NON_UTILISE,
    ACCOUNT_CAPABILITIES: NON_UTILISE,
  };
}
