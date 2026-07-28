/**
 * Étape 8 — identification des entités (opération `identify_entities`).
 *
 * Produit les candidats bien / pièce / équipement. Tous les identifiants
 * renvoyés sont revérifiés en base avant d'être considérés comme exploitables
 * (§4.1.7 et `identifier-verifier.ts`).
 *
 * CDC §4.1.7 : « L'identification d'un équipement doit être fournie dans la
 * sortie de l'analyse ; un second appel IA ne doit être lancé que si le
 * rapprochement reste ambigu. » Les équipements sortent donc d'ici, et non plus
 * d'un service autonome appelé après coup (défaut n°5 du §2.2).
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { IdentifyEntitiesOutput } from '../schemas';
import { verifyCandidates } from '../identifier-verifier';
import type {
  SourceInput, AnalysisContext, LinkCandidate, AnalysisWarning, AiOperationTrace,
} from '../types';
import { emptyTrace, mergeTrace } from '../trace';

export interface IdentifyEntitiesResult {
  assetCandidates: LinkCandidate[];
  roomCandidates: LinkCandidate[];
  equipmentCandidates: LinkCandidate[];
  warnings: AnalysisWarning[];
  trace: AiOperationTrace;
}

export async function identifyEntities(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
  hints: { title?: string; supplierName?: string; extractedText?: string },
): Promise<IdentifyEntitiesResult> {
  const warnings: AnalysisWarning[] = [];

  // Bien déjà rattaché à l'upload : le rattachement est un fait, pas une
  // hypothèse. Aucun appel modèle sur les biens dans ce cas.
  const assetIsKnown = Boolean(ctx.linkedAssetId);

  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: 'identify_entities',
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: {
      ASSETS: assetIsKnown ? '' : listAssets(ctx),
      ROOMS: listRooms(ctx),
      EQUIPMENTS: listEquipments(ctx),
      KNOWN_ASSET_ID: ctx.linkedAssetId ? String(ctx.linkedAssetId) : '',
      TITLE: hints.title ?? '',
      SUPPLIER: hints.supplierName ?? '',
      CONTENT_SAMPLE: (hints.extractedText ?? input.extractedContent ?? '').slice(0, 6000),
    },
    outputSchema: IdentifyEntitiesOutput,
    sourceVersion: input.sourceVersion,
  });

  const out = res.data;

  if (out.multiAsset) {
    warnings.push({
      code: 'MULTI_ASSET_DOCUMENT',
      message:
        'Le document concerne plusieurs biens. Les valeurs seront proposées bien par bien ' +
        'et la réconciliation traitera les cas ambigus.',
    });
  }

  // Vérification locale — un identifiant halluciné ne doit jamais servir.
  const [assetsV, roomsV, equipV] = await Promise.all([
    verifyCandidates('asset', normalize(out.assets), input.accountId),
    verifyCandidates('room', normalize(out.rooms), input.accountId),
    verifyCandidates('equipment', normalize(out.equipments), input.accountId),
  ]);

  warnings.push(...assetsV.warnings, ...roomsV.warnings, ...equipV.warnings);

  const assetCandidates = assetIsKnown
    ? [{
        entityId: ctx.linkedAssetId!,
        confidence: 'certain' as const,
        score: 1,
        reason: "bien choisi par l'utilisateur au dépôt du document",
        excerpt: '',
        verified: true,
      }]
    : assetsV.candidates;

  if (!assetIsKnown && assetCandidates.filter((c) => c.verified).length > 1) {
    warnings.push({
      code: 'AMBIGUOUS_ASSET',
      message: 'Plusieurs biens correspondent. Le rattachement sera arbitré par la réconciliation.',
    });
  }

  return {
    assetCandidates,
    roomCandidates: roomsV.candidates,
    equipmentCandidates: equipV.candidates,
    warnings,
    trace: mergeTrace(emptyTrace(), res, 'identify_entities'),
  };
}

function normalize(raw: Array<{
  entityId: number | null; rawLabel?: string; score: number;
  confidence: 'certain' | 'probable' | 'conflictual'; reason: string; excerpt: string;
}>): LinkCandidate[] {
  return raw.map((c) => ({ ...c, verified: false }));
}

// Contexte borné : identifiant + libellé, rien de plus (§5.6).
function listAssets(ctx: AnalysisContext): string {
  return ctx.assets.slice(0, 60)
    .map((a) => `[id:${a.id}] ${a.name}${a.subtype ? ` (${a.subtype})` : ''}`).join('\n');
}
function listRooms(ctx: AnalysisContext): string {
  return ctx.rooms.slice(0, 80).map((r) => `[id:${r.id}] ${r.name}`).join('\n');
}
function listEquipments(ctx: AnalysisContext): string {
  return ctx.equipments.slice(0, 80)
    .map((e) => `[id:${e.id}] ${e.name}${e.type ? ` (${e.type})` : ''}`).join('\n');
}
