/**
 * Étape 6 ter — classement par Rubrique V2. CDC V2.0 §3.4, §11.2, §11.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA V2 SUPPRIME PRESQUE TOUS LES APPELS MODÈLE DE CETTE ÉTAPE
 *
 * En V1, un `FACTURE` admettait quatre catégories : il fallait interroger le
 * modèle pour trancher. Le §2.2 de la V2 interdit les Types multi-rubriques
 * et scinde `FACTURE` par finalité — facture d'acquisition, d'entretien, de
 * réparation, de travaux. Dès qu'un Type V2 est déterminé, la Rubrique est
 * DÉDUITE : aucun appel, aucune latence, aucun coût.
 *
 * Le modèle n'est sollicité que lorsque l'étape précédente n'a produit aucun
 * Type V2 exploitable — c'est-à-dire quand elle a rendu un Type V1 générique
 * ou inconnu du plan de correspondance.
 *
 * ── LE MODÈLE REÇOIT LES EXCLUSIONS, PAS SEULEMENT LES FINALITÉS ──────────
 *
 * Le §3.4 est une instruction normative : « Classer selon la finalité
 * principale du document, jamais selon son caractère administratif, officiel,
 * contrat, facture ou un mot-clé isolé. »
 *
 * Une liste de finalités ne suffit pas à la tenir. « Propriété et gestion » et
 * « Entretien et travaux » acceptent toutes deux le mot « facture » ; ce qui
 * les sépare est ce que chacune REFUSE. `buildPromptReferential()` transmet
 * donc `exclusions` au même titre que `purpose`.
 *
 * ── LES TYPES « AUTRE » NE SONT PAS DANS LE PROMPT ────────────────────────
 *
 * Le §11.4 demande de « ne jamais sélectionner ou proposer un Type Autre ».
 * Plutôt que de l'écrire dans la consigne — qu'un modèle peut ignorer — la
 * projection les retire purement et simplement. Le garde-fou de sortie les
 * rejette en second rideau (DOC-08).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetTypes, assets } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { AiGateway } from '../../gateway/ai-gateway';
import { ClassifyRubricOutput } from '../schemas';
import type { SourceInput, AiOperationTrace } from '../types';
import { emptyTrace, mergeTrace } from '../trace';
import {
  ASSET_FAMILIES,
  buildPromptReferential,
  getDocumentType,
  getRubric,
  getVisibleRubrics,
  isAiSelectable,
  isApplicableToFamily,
  REFERENTIAL_VERSION,
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

export interface ClassifyRubricResult {
  proposal?: RubricProposal;
  /** true si aucun appel modèle n'a été nécessaire. */
  deterministic: boolean;
  /** Version du prompt, pour la trace du §11.5. */
  promptVersion: string | null;
  referentialVersion: string;
  trace: AiOperationTrace;
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
 * Déduction déterministe depuis le Type produit par l'étape précédente.
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

export async function classifyRubric(
  input: SourceInput,
  groupIndices: number[],
  contexte: {
    /** Type retenu à l'étape précédente — V1 ou V2. */
    documentType?: string;
    assetIds: number[];
    title?: string;
    extractedText?: string;
  },
): Promise<ClassifyRubricResult> {
  const families = await loadAssetFamilies(contexte.assetIds);

  // ── 1. Déduction déterministe (§2.2) ────────────────────────────────────
  const deduced = deduceFromType(contexte.documentType);
  if (deduced && isRubricApplicable(deduced.rubricCode, families)) {
    return {
      proposal: deduced,
      deterministic: true,
      promptVersion: null,
      referentialVersion: REFERENTIAL_VERSION,
      trace: emptyTrace(),
    };
  }

  // ── 2. Appel modèle, sur les Rubriques applicables seulement ────────────
  //
  // `getVisibleRubrics` avec les deux drapeaux locatifs à true : la Rubrique
  // « Gestion locative » doit rester PROPOSABLE même si aucun bien n'est
  // actuellement marqué loué. C'est précisément un bail entrant qui fera
  // basculer l'attribut (§6.3), et l'écarter ici empêcherait le document qui
  // porte la preuve d'être classé correctement.
  const applicable = getVisibleRubrics({
    families,
    hasRentedAsset: true,
    hasRentalDocuments: true,
  }).map((r) => r.code);

  const catalogue = buildPromptReferential();
  const catalogueText = catalogue.rubrics
    .filter((r) => applicable.includes(r.code))
    .map((r) => {
      const types = r.types
        .filter((t) => t.applicability.some((f) => families.includes(f)))
        .map((t) => `    · ${t.code} — ${t.label} : ${t.purpose}`)
        .join('\n');
      return (
        `${r.code} — ${r.label}\n` +
        `  Finalité : ${r.purpose}\n` +
        `  N'inclut pas : ${r.exclusions}\n` +
        (types ? `  Types :\n${types}` : '')
      );
    })
    .join('\n\n');

  const res = await AiGateway.execute({
    useCaseCode: 'SOURCE_ANALYSIS',
    operationCode: 'classify_rubric',
    accountId: input.accountId,
    userId: input.userId,
    sourceIds: groupIndices.map((i) => input.sourceIds[i]),
    promptVariables: {
      TITLE: contexte.title ?? '',
      DOCUMENT_TYPE_HINT: contexte.documentType ?? '',
      ASSET_FAMILIES: families.join(', '),
      RUBRIC_CATALOG: catalogueText,
      CONTENT_SAMPLE: (contexte.extractedText ?? input.extractedContent ?? '').slice(0, 3000),
    },
    outputSchema: ClassifyRubricOutput,
    sourceVersion: input.sourceVersion,
  });

  const trace = mergeTrace(emptyTrace(), res, 'classify_rubric');
  const proposal = validateProposal(res.data, applicable, families);

  return {
    proposal: proposal ?? undefined,
    deterministic: false,
    promptVersion: res.promptVersion ?? null,
    referentialVersion: REFERENTIAL_VERSION,
    trace,
  };
}

function isRubricApplicable(code: RubricCode, families: AssetFamily[]): boolean {
  const rubric = getRubric(code);
  if (!rubric) return false;
  return families.some((f) => isApplicableToFamily(rubric.applicability, f));
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
      `[classify-rubric] Rubrique hors périmètre ignorée : ${data.rubricCode} ` +
        `(attendues : ${applicable.join(', ')})`,
    );
    return null;
  }

  const rubricCode = data.rubricCode as RubricCode;
  let typeCode: string | null = data.documentTypeCode ?? null;

  if (typeCode) {
    const type = getDocumentType(typeCode);
    if (!type) {
      console.warn(`[classify-rubric] Type inconnu ignoré : ${typeCode}`);
      typeCode = null;
    } else if (!isAiSelectable(typeCode)) {
      // DOC-08 : second rideau, la projection ne les transmet déjà pas.
      console.warn(`[classify-rubric] Type « Autre » proposé par le modèle, ignoré : ${typeCode}`);
      typeCode = null;
    } else if (rubricOfType(typeCode) !== rubricCode) {
      console.warn(
        `[classify-rubric] Type ${typeCode} incohérent avec ${rubricCode}, ignoré.`,
      );
      typeCode = null;
    } else if (!type.applicability || !families.some((f) => isApplicableToFamily(type.applicability, f))) {
      console.warn(`[classify-rubric] Type ${typeCode} inapplicable aux biens rattachés, ignoré.`);
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
