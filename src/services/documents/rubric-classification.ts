/**
 * Règles de classement V2 — CDC V2.0 §2.2, §4.4, §5.1, §10.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RUPTURE AVEC LA V1 TIENT EN UNE PHRASE
 *
 * §2.2 : « La V1 considérait un document comme classé seulement si catégorie
 * + type étaient renseignés. En V2, seule la Rubrique conditionne le
 * rangement. L'absence de Type est un enrichissement à traiter séparément. »
 *
 * Conséquence directe sur ce module : un Type manquant ne retire plus le
 * document de sa Rubrique. `classification-rules.ts` (V1) fait l'inverse — il
 * calcule un état `TO_CLASSIFY` dès que l'un des deux manque. Les deux
 * cohabitent le temps de la migration ; ce fichier est la cible.
 *
 * ── CE QUI A DISPARU, ET C'EST TANT MIEUX ─────────────────────────────────
 *
 * La V1 devait gérer les Types compatibles avec plusieurs catégories, et donc
 * les trois règles de retrait du §4.3 : type retiré, catégorie retirée,
 * catégorie réattribuée automatiquement. Le §2.2 de la V2 interdit les Types
 * multi-rubriques, et tout cet appareil s'évapore : la Rubrique se DÉDUIT du
 * Type, elle ne se négocie plus avec lui.
 *
 * Lot 86E : un Type générique peut être réutilisable dans plusieurs Rubriques
 * (`alsoIn`). La règle reste simple : la Rubrique courante est conservée si
 * le Type y est proposé, sinon elle est déduite de la Rubrique d'attache.
 *
 * Il ne reste qu'une règle de cohérence, §5.1 : « Si la Rubrique change et
 * que le Type actuel n'est pas compatible, le Type est vidé. »
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  getDocumentType,
  getRubric,
  isApplicableToFamily,
  isTypeCompatibleWithRubric,
  rubricForType,
  REFERENTIAL_VERSION,
  type AssetFamily,
  type RubricCode,
} from '@/lib/referential/v2';
import type { ValueOrigin } from '@/services/to-process/action-model';

export interface DocumentClassification {
  rubricCode: RubricCode | null;
  documentTypeCode: string | null;
  rubricOrigin: ValueOrigin | null;
  typeOrigin: ValueOrigin | null;
  rubricUserValidated: boolean;
  typeUserValidated: boolean;
}

interface ClassificationChangeInput {
  current: DocumentClassification;
  /** Rubrique voulue. `undefined` = inchangée, `null` = retirée. */
  nextRubric?: RubricCode | null;
  /** Type voulu. `undefined` = inchangé, `null` = retiré. */
  nextType?: string | null;
  /** Qui demande la modification. */
  origin: ValueOrigin;
  /** Familles des biens rattachés, pour le contrôle d'applicabilité (§4.4). */
  assetFamilies?: readonly AssetFamily[];
}

interface ClassificationChangeOutcome {
  result: DocumentClassification;
  /** Version du référentiel à inscrire avec la décision (§11.6). */
  referentialVersion: string;
  /** Ce qui a changé, pour la trace technique (§12.1). */
  changes: string[];
  /** Ce qui a été refusé, et pourquoi. */
  rejected: string[];
}

/**
 * Applique une modification de classement.
 *
 * L'ordre compte : la protection des valeurs utilisateur est évaluée avant
 * toute écriture, puis la Rubrique est déduite du Type, puis la cohérence est
 * rétablie. Déduire avant de protéger permettrait à l'IA d'installer une
 * Rubrique par la bande, via un Type, là où elle ne pouvait pas l'écrire
 * directement.
 */
export function applyClassificationChange(
  input: ClassificationChangeInput,
): ClassificationChangeOutcome {
  const changes: string[] = [];
  const rejected: string[] = [];
  const byUser = input.origin === 'USER';

  let { rubricCode, documentTypeCode } = input.current;
  let { rubricOrigin, typeOrigin, rubricUserValidated, typeUserValidated } = input.current;

  // ── Protection des valeurs utilisateur (§12.2, AI-02) ───────────────────
  const rubricTouched = input.nextRubric !== undefined;
  const typeTouched = input.nextType !== undefined;

  if (rubricTouched) {
    if (!byUser && rubricUserValidated) {
      rejected.push(
        'Rubrique validée par l’utilisateur : une meilleure proposition doit passer ' +
          'par « À arbitrer » (§12.2).',
      );
    } else if (input.nextRubric !== null && !getRubric(input.nextRubric)) {
      rejected.push(`Rubrique inconnue du référentiel : ${input.nextRubric}.`);
    } else {
      if (rubricCode !== input.nextRubric) {
        changes.push(`Rubrique : ${rubricCode ?? '—'} → ${input.nextRubric ?? '—'}`);
      }
      rubricCode = input.nextRubric ?? null;
      rubricOrigin = input.origin;
      if (byUser) rubricUserValidated = true;
    }
  }

  if (typeTouched) {
    const proposed = input.nextType;
    if (!byUser && typeUserValidated) {
      rejected.push(
        'Type validé par l’utilisateur : une proposition plus précise crée une ' +
          'action « À arbitrer » (§5.2).',
      );
    } else if (proposed !== null && !getDocumentType(proposed)) {
      rejected.push(`Type inconnu du référentiel : ${proposed}.`);
    } else if (proposed !== null && !byUser && getDocumentType(proposed)?.userOnly) {
      // DOC-08 : l'IA ne sélectionne ni ne propose jamais un Type « Autre ».
      rejected.push(
        `Type « Autre » (${proposed}) réservé au choix de l’utilisateur (DOC-08).`,
      );
    } else {
      if (documentTypeCode !== proposed) {
        changes.push(`Type : ${documentTypeCode ?? '—'} → ${proposed ?? '—'}`);
      }
      documentTypeCode = proposed ?? null;
      typeOrigin = input.origin;
      if (byUser) typeUserValidated = true;
    }
  }

  // ── Déduction de la Rubrique depuis le Type (§2.2) ──────────────────────
  //
  // « Un document ne peut pas avoir un Type sans Rubrique : lorsqu'un Type est
  //   déterminé, sa Rubrique est déduite. »
  //
  // ── LA DÉDUCTION NE VAUT QUE POUR LE TYPE QU'ON VIENT DE POSER ──────────
  //
  // Appliquée à un Type déjà en place, elle entrerait en conflit frontal avec
  // le §5.1 : « Si la Rubrique change et que le Type actuel n'est pas
  // compatible, le Type est vidé. » Un utilisateur déplaçant une facture de
  // réparation vers « Contrôles et conformité » verrait sa Rubrique
  // silencieusement ramenée à « Entretien et travaux » par le Type qu'il
  // n'a pas touché — l'inverse exact de ce qu'il demandait.
  //
  // La déduction ne s'applique donc qu'au Type explicitement fourni, ou à
  // défaut de toute Rubrique.
  // Lot 86E : un Type réutilisable garde la Rubrique courante quand il y est
  // proposé (« Bon de commande » en « Équipements et mobilier ») ; sinon sa
  // Rubrique d'attache est déduite (`rubricForType`).
  if (documentTypeCode && (typeTouched || !rubricCode)) {
    const deduced = rubricForType(documentTypeCode, rubricCode);
    if (deduced && rubricCode !== deduced) {
      // Une Rubrique validée par l'utilisateur ne cède pas à une déduction
      // automatique : c'est le Type qui est alors refusé.
      if (rubricCode && rubricUserValidated && !byUser) {
        rejected.push(
          `Type ${documentTypeCode} écarté : sa Rubrique (${deduced}) contredit une ` +
            'Rubrique validée par l’utilisateur.',
        );
        documentTypeCode = input.current.documentTypeCode;
        typeOrigin = input.current.typeOrigin;
      } else {
        changes.push(`Rubrique déduite du Type : ${rubricCode ?? '—'} → ${deduced}`);
        rubricCode = deduced;
        rubricOrigin = rubricOrigin ?? input.origin;
        if (byUser) rubricUserValidated = true;
      }
    }
  }

  // ── Cohérence Rubrique / Type (§5.1) ────────────────────────────────────
  //
  // « Si la Rubrique change et que le Type actuel n'est pas compatible, le
  //   Type est vidé. »
  if (rubricCode && documentTypeCode && !isTypeCompatibleWithRubric(documentTypeCode, rubricCode)) {
    changes.push(`Type ${documentTypeCode} vidé : il n’appartient pas à ${rubricCode}.`);
    documentTypeCode = null;
    typeOrigin = null;
    typeUserValidated = false;
  }

  // ── Applicabilité aux biens rattachés (§4.4) ────────────────────────────
  if (rubricCode && input.assetFamilies?.length) {
    const rubric = getRubric(rubricCode)!;
    const applicable = input.assetFamilies.some((f) =>
      isApplicableToFamily(rubric.applicability, f),
    );
    if (!applicable) {
      // La Rubrique validée par l'utilisateur n'est pas retirée : le §12.2 ne
      // souffre aucune exception, et le conflit relève d'un arbitrage.
      if (rubricUserValidated) {
        rejected.push(
          `Rubrique ${rubricCode} inapplicable aux biens rattachés, mais validée par ` +
            'l’utilisateur : conservée, à arbitrer.',
        );
      } else {
        changes.push(`Rubrique ${rubricCode} retirée : inapplicable aux biens rattachés.`);
        rubricCode = null;
        rubricOrigin = null;
        if (documentTypeCode) {
          changes.push(`Type ${documentTypeCode} vidé avec sa Rubrique.`);
          documentTypeCode = null;
          typeOrigin = null;
          typeUserValidated = false;
        }
      }
    }
  }

  return {
    result: {
      rubricCode,
      documentTypeCode,
      rubricOrigin,
      typeOrigin,
      rubricUserValidated,
      typeUserValidated,
    },
    referentialVersion: REFERENTIAL_VERSION,
    changes,
    rejected,
  };
}

