/**
 * Étape 6 bis — classement par catégorie. CDC 5 §7.1, §4.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÊME MOTIF QUE LA CLASSIFICATION PAR TYPE, UN CRAN AU-DESSUS
 *
 * `classify-document.step.ts` cherche d'abord une correspondance
 * déterministe, et n'appelle le modèle que si elle échoue. Cette étape fait
 * exactement pareil, sur la catégorie.
 *
 * Et la règle déterministe existe déjà : le §4.3 dit qu'un type compatible
 * avec une seule catégorie la reçoit automatiquement. `decideCategory`, écrit
 * et testé pour la reprise mécanique, la met en œuvre sans base ni modèle.
 *
 * Concrètement : un `DPE`, un `CONTROLE_TECHNIQUE`, une `GARANTIE` n'appellent
 * jamais le modèle. Seuls les types réellement ambigus — `FACTURE`, qui admet
 * quatre catégories, ou `AUTRE` qui les admet toutes — le sollicitent.
 *
 * ── LE MODÈLE NE CHOISIT QUE PARMI DES CANDIDATES ─────────────────────────
 *
 * Il ne reçoit jamais la liste complète des catégories, mais celles que le
 * référentiel autorise POUR CE DOCUMENT — compte tenu de son type et des
 * biens auxquels il est rattaché (§4.4).
 *
 * Un modèle libre de proposer n'importe quelle catégorie produirait des
 * classements que l'interface refuserait ensuite d'afficher, et l'utilisateur
 * verrait son document rester « à classer » sans comprendre pourquoi.
 *
 * ── LA CONFIANCE EST ENREGISTRÉE, JAMAIS EXPOSÉE ──────────────────────────
 *
 * Le §8.2 est formel. Elle sert à mesurer la qualité du modèle et à alimenter
 * le signal d'échec du §5.2 ; elle n'a rien à faire dans une interface.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import {
  assets,
  documentCategories,
  documentCategoryAssetAssociations,
  documentCategoryTypeAssociations,
  documentTypes,
} from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { AiGateway } from '../../gateway/ai-gateway';
import { ClassifyCategoryOutput } from '../schemas';
import type { SourceInput, AiOperationTrace } from '../types';
import type { EvidenceValue } from '../../evidence/evidence.types';
import { emptyTrace, mergeTrace } from '../trace';
import {
  buildCompatibilityIndex,
  type CompatibilityIndex,
} from '@/services/documents/classification-rules';
import { decideCategory } from '@/services/documents/reclassify.service';

export interface ClassifyCategoryResult {
  category?: EvidenceValue<string>;
  /** Pourquoi le modèle n'a pas été appelé, le cas échéant. */
  deterministic: boolean;
  trace: AiOperationTrace;
}

/**
 * Index de compatibilité applicable à un document.
 *
 * Les catégories retenues sont celles compatibles avec TOUS les biens
 * rattachés (§4.4) : en proposer une valable pour l'un et pas pour l'autre
 * produirait un classement impossible à afficher dans les deux onglets.
 */
async function buildIndex(assetIds: number[]): Promise<{
  index: CompatibilityIndex;
  libelles: Map<string, string>;
}> {
  const [associations, categories] = await Promise.all([
    db
      .select({ typeCode: documentTypes.code, categoryCode: documentCategories.code })
      .from(documentCategoryTypeAssociations)
      .innerJoin(documentTypes, eq(documentCategoryTypeAssociations.documentTypeId, documentTypes.id))
      .innerJoin(documentCategories, eq(documentCategoryTypeAssociations.categoryId, documentCategories.id))
      .where(and(
        eq(documentCategoryTypeAssociations.isActive, true),
        eq(documentCategories.isActive, true),
      )),
    db
      .select({
        id: documentCategories.id,
        code: documentCategories.code,
        label: documentCategories.genericLabel,
      })
      .from(documentCategories)
      .where(eq(documentCategories.isActive, true)),
  ]);

  let applicables = categories.map((c) => c.code);

  if (assetIds.length > 0) {
    const rows = await db
      .select({ assetTypeId: assets.assetTypeId })
      .from(assets)
      .where(inArray(assets.id, assetIds));
    const familles = [...new Set(rows.map((r) => r.assetTypeId).filter(Boolean))] as number[];

    if (familles.length > 0) {
      const scopes = await db
        .select({
          categoryId: documentCategoryAssetAssociations.categoryId,
          assetTypeId: documentCategoryAssetAssociations.assetTypeId,
        })
        .from(documentCategoryAssetAssociations);

      applicables = categories
        .filter((c) => {
          const regles = scopes.filter((s) => s.categoryId === c.id);
          // Une règle sans famille vaut pour toutes (§3.2).
          if (regles.some((s) => s.assetTypeId === null)) return true;
          return familles.every((f) => regles.some((s) => s.assetTypeId === f));
        })
        .map((c) => c.code);
    }
  }

  return {
    index: buildCompatibilityIndex(associations, applicables),
    libelles: new Map(categories.map((c) => [c.code, c.label])),
  };
}

export async function classifyCategory(
  input: SourceInput,
  groupIndices: number[],
  contexte: {
    /** Type retenu à l'étape précédente. */
    documentType?: string;
    assetIds: number[];
    title?: string;
    extractedText?: string;
  },
): Promise<ClassifyCategoryResult> {
  const { index, libelles } = await buildIndex(contexte.assetIds);

  // Index sans restriction de bien : sert à distinguer « type inconnu » de
  // « catégorie inapplicable aux biens rattachés ».
  const complet = buildCompatibilityIndex(
    await db
      .select({ typeCode: documentTypes.code, categoryCode: documentCategories.code })
      .from(documentCategoryTypeAssociations)
      .innerJoin(documentTypes, eq(documentCategoryTypeAssociations.documentTypeId, documentTypes.id))
      .innerJoin(documentCategories, eq(documentCategoryTypeAssociations.categoryId, documentCategories.id)),
    [...libelles.keys()],
  );

  // ── 1. Règle déterministe (§4.3) ────────────────────────────────────────
  const verdict = decideCategory(contexte.documentType ?? null, index, complet);

  if (verdict.decision === 'classify') {
    return {
      category: {
        value: verdict.categoryCode,
        // Une déduction du référentiel n'est pas une estimation : c'est la
        // seule catégorie possible.
        confidence: 'certain',
        excerpt: contexte.documentType ?? '',
        location: {},
      },
      deterministic: true,
      trace: emptyTrace(),
    };
  }

  if (verdict.decision === 'skip') {
    // Type inconnu du référentiel, ou catégorie inapplicable aux biens
    // rattachés. Le modèle ne saurait pas mieux : c'est le référentiel ou le
    // rattachement qu'il faut reprendre.
    return { deterministic: true, trace: emptyTrace() };
  }

  // ── 2. Appel modèle, sur candidates seulement ───────────────────────────
  const candidates = contexte.documentType
    ? index.categoriesForType(contexte.documentType)
    : index.categoriesForAssets();

  if (candidates.length === 0) {
    return { deterministic: true, trace: emptyTrace() };
  }

  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: 'classify_category',
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: {
      DOCUMENT_TYPE: contexte.documentType ?? '',
      TITLE: contexte.title ?? '',
      CONTENT_SAMPLE: (contexte.extractedText ?? input.extractedContent ?? '').slice(0, 3000),
      // Codes ET libellés : le modèle raisonne mieux sur « Entretien et
      // réparations » que sur `ENTRETIEN_REPARATIONS`, mais doit rendre le code.
      CANDIDATE_CATEGORIES: candidates
        .map((c) => `${c} — ${libelles.get(c) ?? c}`)
        .join('\n'),
    },
    outputSchema: ClassifyCategoryOutput,
    sourceVersion: input.sourceVersion,
  });

  const propose = res.data.categoryCode;

  // Garde-fou : le modèle peut rendre un code hors liste malgré la consigne.
  // L'accepter produirait un classement que l'interface refuserait d'afficher,
  // et le document resterait « à classer » sans explication.
  if (!candidates.includes(propose)) {
    console.warn(
      `[classify-category] code hors candidates ignoré : ${propose} ` +
      `(attendus : ${candidates.join(', ')})`,
    );
    return {
      deterministic: false,
      trace: mergeTrace(emptyTrace(), res, 'classify_category'),
    };
  }

  return {
    category: {
      value: propose,
      confidence: res.data.confidence,
      excerpt: res.data.excerpt,
      location: {},
    },
    deterministic: false,
    trace: mergeTrace(emptyTrace(), res, 'classify_category'),
  };
}
