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
 * sans valeur : chaque branche fournit donc EXACTEMENT les huit variables
 * ci-dessous (TASK est fixée par le serveur, jamais par l'appelant).
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

/** Emplacements du master `t1_master_v1` (hors `{{TASK}}`). */
export const T1_PROMPT_VARIABLES = [
  'SOURCES', 'ENTITY_CONTEXT', 'KNOWN_TARGET', 'FIELD_CATALOG',
  'EVENT_CATALOG', 'DOCUMENT_CATALOG', 'EXISTING_TITLES', 'EXTRACTED_CONTENT',
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

/** ENTITY_CONTEXT : identifiants et libellés bornés. */
export function describeEntities(ctx: AnalysisContext): string {
  return JSON.stringify({
    assets: ctx.assets.slice(0, MAX_ASSETS).map((a) => ({
      id: a.id, name: a.name, family: toAssetFamily(a.category) ?? null, subtype: a.subtype ?? null,
    })),
    rooms: ctx.rooms.slice(0, MAX_ROOMS).map((r) => ({ id: r.id, name: r.name, assetId: r.assetId })),
    equipments: ctx.equipments.slice(0, MAX_EQUIPMENTS).map((e) => ({
      id: e.id, name: e.name, type: e.type ?? null, assetId: e.assetId,
    })),
  });
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
}): T1PromptVariables {
  // T1-01 : registre canonique filtré par la famille du bien connu ; sans
  // bien connu, le registre complet (le modèle ne sait pas encore la cible).
  const catalog = catalogForPrompts({ family: knownTargetFamily(p.ctx) });
  return {
    SOURCES: describeSources(p.input, p.groupIndices),
    ENTITY_CONTEXT: describeEntities(p.ctx),
    KNOWN_TARGET: describeKnownTarget(p.ctx),
    FIELD_CATALOG: JSON.stringify({ version: catalog.version, family: catalog.family, fields: catalog.fields }),
    EVENT_CATALOG: JSON.stringify(catalog.events),
    DOCUMENT_CATALOG: describeDocumentCatalog(catalog.documents, p.v2Families),
    EXISTING_TITLES: JSON.stringify(p.ctx.existingTitles.slice(0, MAX_TITLES)),
    // Donnée DÉLIMITÉE (chaîne JSON) : un contenu de page web ne peut pas se
    // faire passer pour une consigne du master (injection).
    EXTRACTED_CONTENT: JSON.stringify(p.input.extractedContent ?? ''),
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
  };
}
