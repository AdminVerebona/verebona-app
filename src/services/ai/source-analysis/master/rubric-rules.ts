/**
 * Classement V2 (Rubrique, Type) d'un document analysé par le master T1 —
 * CDC V2.0 §2.2, §3.4, §11.2, §11.4.
 *
 * Règles DÉTERMINISTES appliquées à la classification proposée par la branche
 * ANALYZE_DOCUMENT (`analyse-group-master#rubricOf`) et au classement V2 de
 * la persistance (`applyV2Classification`) :
 *   · `loadAssetFamilies` : familles des biens rattachés ;
 *   · `deduceFromType` : Rubrique déduite d'un Type V2 (ou V1 du plan de
 *     correspondance) — aucun appel modèle ;
 *   · `validateProposal` : garde-fou de sortie (Rubrique hors périmètre,
 *     Type « Autre », Type incohérent ou inapplicable écartés).
 *
 * Lot 16b-3 : l'ancienne étape `classify_rubric` (appel modèle dédié) est
 * supprimée avec le chemin « étapes » ; seules ces règles demeurent.
 */
import { db } from '@/db';
import { assetTypes, assets } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  ASSET_FAMILIES,
  getDocumentType,
  isAiSelectable,
  isApplicableToFamily,
  rubricOfType,
  type AssetFamily,
  type RubricCode,
} from '@/lib/referential/v2';
import { resolveLegacyType } from '@/lib/referential/v2/legacy-mapping';

export interface RubricProposal {
  rubricCode: RubricCode;
  documentTypeCode: string | null;
  /** 0 → 1. Comparé au seuil fixe de 90 % par le moteur de décision (§11.2). */
  confidence: number;
  excerpt: string;
}

/**
 * Familles des biens rattachés.
 *
 * Sans bien rattaché, toutes les familles sont retenues : restreindre au
 * hasard écarterait des Rubriques légitimes, et le rattachement fait de toute
 * façon l'objet de sa propre règle (LINK-ASSET).
 */
export async function loadAssetFamilies(assetIds: number[]): Promise<AssetFamily[]> {
  if (assetIds.length === 0) return [...ASSET_FAMILIES];

  const rows = await db
    .select({ code: assetTypes.code })
    .from(assets)
    .leftJoin(assetTypes, eq(assets.assetTypeId, assetTypes.id))
    .where(inArray(assets.id, assetIds));

  const families = rows
    .map((r) => r.code)
    .filter((c): c is AssetFamily =>
      !!c && (ASSET_FAMILIES as readonly string[]).includes(c),
    );

  return families.length > 0 ? [...new Set(families)] : [...ASSET_FAMILIES];
}

/**
 * Déduction déterministe depuis le Type proposé par le master T1.
 *
 * Exportée et pure : c'est le chemin emprunté par la majorité des documents,
 * et celui qu'on doit pouvoir tester sans base ni modèle.
 */
export function deduceFromType(
  typeCode: string | null | undefined,
): RubricProposal | null {
  if (!typeCode) return null;

  // Type déjà V2 : la Rubrique se déduit sans intermédiaire (§2.2).
  const direct = getDocumentType(typeCode);
  if (direct) {
    // Un « Autre » ne peut pas venir de l'analyse : seul l'utilisateur le pose.
    if (!isAiSelectable(typeCode)) return null;
    return {
      rubricCode: direct.rubric,
      documentTypeCode: direct.code,
      // Une déduction du référentiel n'est pas une estimation : c'est la seule
      // Rubrique possible. Elle passe donc le seuil du §11.2 de plein droit.
      confidence: 1,
      excerpt: typeCode,
    };
  }

  // Type V1 : le plan de correspondance tranche, ou renvoie au retraitement.
  const legacy = resolveLegacyType({ typeCode, userSelected: false });
  if (legacy.verdict === 'MAPPED' && legacy.typeCode && legacy.rubricCode) {
    return {
      rubricCode: legacy.rubricCode,
      documentTypeCode: legacy.typeCode,
      confidence: 1,
      excerpt: typeCode,
    };
  }

  return null;
}

/**
 * Garde-fou de sortie.
 *
 * Le modèle peut rendre un code hors périmètre malgré la consigne, ou un Type
 * qui n'appartient pas à la Rubrique qu'il annonce. Accepter l'un ou l'autre
 * produirait un classement que l'interface refuserait d'afficher, et le
 * document resterait « Sans rubrique » sans que rien ne l'explique.
 *
 * La Rubrique est conservée quand seul le Type est fautif : ranger le document
 * vaut mieux que le laisser sans rubrique pour un enrichissement raté, et le
 * Type manquant relève de sa propre règle, en « Peut attendre » (DOC-TYP-03).
 */
export function validateProposal(
  data: { rubricCode: string; documentTypeCode?: string | null; confidence: number; excerpt: string },
  applicable: readonly string[],
  families: AssetFamily[],
): RubricProposal | null {
  if (!applicable.includes(data.rubricCode)) {
    console.warn(
      `[t1-rubrique] Rubrique hors périmètre ignorée : ${data.rubricCode} ` +
        `(attendues : ${applicable.join(', ')})`,
    );
    return null;
  }

  const rubricCode = data.rubricCode as RubricCode;
  let typeCode: string | null = data.documentTypeCode ?? null;

  if (typeCode) {
    const type = getDocumentType(typeCode);
    if (!type) {
      console.warn(`[t1-rubrique] Type inconnu ignoré : ${typeCode}`);
      typeCode = null;
    } else if (!isAiSelectable(typeCode)) {
      // DOC-08 : second rideau, la projection ne les transmet déjà pas.
      console.warn(`[t1-rubrique] Type « Autre » proposé par le modèle, ignoré : ${typeCode}`);
      typeCode = null;
    } else if (rubricOfType(typeCode) !== rubricCode) {
      console.warn(
        `[t1-rubrique] Type ${typeCode} incohérent avec ${rubricCode}, ignoré.`,
      );
      typeCode = null;
    } else if (!type.applicability || !families.some((f) => isApplicableToFamily(type.applicability, f))) {
      console.warn(`[t1-rubrique] Type ${typeCode} inapplicable aux biens rattachés, ignoré.`);
      typeCode = null;
    }
  }

  return {
    rubricCode,
    documentTypeCode: typeCode,
    confidence: data.confidence,
    excerpt: data.excerpt,
  };
}
