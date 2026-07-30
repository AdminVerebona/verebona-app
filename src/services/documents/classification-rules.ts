/**
 * Règles de classement documentaire — CDC 5 §2.2, §2.3, §4.2, §4.3, §5.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TOUTE LA LOGIQUE MÉTIER TIENT ICI, ET SANS BASE
 *
 * Le §4.3 énumère sept situations, dont trois retirent une valeur déjà posée.
 * Ce sont exactement les règles qu'on découvre fausses six mois plus tard,
 * quand un document classé s'est silencieusement déclassé — ou pire, quand une
 * correction manuelle a été écrasée par l'IA.
 *
 * Ce module ne connaît ni base, ni requête : il prend un état et une table de
 * compatibilité, et rend le nouvel état. Chaque ligne du §4.3 y est
 * vérifiable isolément.
 *
 * ── LA DISTINCTION FONDATRICE ─────────────────────────────────────────────
 *
 * Le §1.3 en fait une contrainte majeure : « À classer est un état système et
 * ne doit jamais être représenté par le type AUTRE ».
 *
 * `AUTRE` est un type VALIDE, disponible dans toutes les catégories (§2.2).
 * `TO_CLASSIFY` est un état, indépendant du type. Un document de type `AUTRE`
 * dans une catégorie valide est CLASSÉ. Un document sans catégorie, quel que
 * soit son type, ne l'est pas.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type ClassificationState = 'CLASSIFIED' | 'TO_CLASSIFY';
export type ClassificationSource = 'AI' | 'USER' | 'REFERENCE_CORRECTION';

/** Type générique, disponible dans toutes les catégories (§3.4, §6.2). */
export const GENERIC_TYPE_CODE = 'AUTRE';

/** Catégorie de dernier recours, obligatoire (§3.2). */
export const FALLBACK_CATEGORY_CODE = 'AUTRES_DOCUMENTS';

/**
 * Table de compatibilité type → catégories, telle qu'elle vit en base.
 *
 * Passée en paramètre plutôt que lue ici : c'est ce qui rend ces règles
 * testables sur des jeux de données choisis, y compris des configurations
 * que la base ne contient pas encore.
 */
export interface CompatibilityIndex {
  /** Catégories compatibles avec un type. `AUTRE` les accepte toutes. */
  categoriesForType(typeCode: string): string[];
  /** Le couple est-il compatible ? */
  isCompatible(typeCode: string, categoryCode: string): boolean;
  /** Catégories applicables aux biens auxquels le document est rattaché. */
  categoriesForAssets(): string[];
}

/**
 * Construit un index à partir d'associations plates.
 *
 * `AUTRE` est traité à part : le §6.2 impose de le « rendre disponible dans
 * toutes les catégories », et l'inscrire explicitement dans chaque
 * association obligerait à le réinscrire à chaque nouvelle catégorie — avec
 * l'oubli garanti au bout de la troisième.
 */
export function buildCompatibilityIndex(
  associations: Array<{ typeCode: string; categoryCode: string }>,
  applicableCategories: string[],
): CompatibilityIndex {
  const byType = new Map<string, Set<string>>();
  for (const { typeCode, categoryCode } of associations) {
    if (!byType.has(typeCode)) byType.set(typeCode, new Set());
    byType.get(typeCode)!.add(categoryCode);
  }
  const applicable = new Set(applicableCategories);

  return {
    categoriesForType(typeCode: string): string[] {
      if (typeCode === GENERIC_TYPE_CODE) return [...applicable];
      return [...(byType.get(typeCode) ?? [])].filter((c) => applicable.has(c));
    },
    isCompatible(typeCode: string, categoryCode: string): boolean {
      if (!applicable.has(categoryCode)) return false;
      if (typeCode === GENERIC_TYPE_CODE) return true;
      return byType.get(typeCode)?.has(categoryCode) ?? false;
    },
    categoriesForAssets: () => [...applicable],
  };
}

/**
 * État de classification d'un document (§2.3).
 *
 * « CLASSIFIED : catégorie renseignée + type renseigné + combinaison
 *   compatible. TO_CLASSIFY : catégorie ou type absent, combinaison
 *   incompatible, ou confiance IA insuffisante sur l'un des deux. »
 */
export function computeClassificationState(
  categoryCode: string | null,
  typeCode: string | null,
  index: CompatibilityIndex,
): ClassificationState {
  if (!categoryCode || !typeCode) return 'TO_CLASSIFY';
  return index.isCompatible(typeCode, categoryCode) ? 'CLASSIFIED' : 'TO_CLASSIFY';
}

export interface ClassificationInput {
  currentCategory: string | null;
  currentType: string | null;
  /** Nouvelle catégorie voulue. `undefined` = inchangée. */
  nextCategory?: string | null;
  /** Nouveau type voulu. `undefined` = inchangé. */
  nextType?: string | null;
  categoryUserLocked?: boolean;
  typeUserLocked?: boolean;
  source: ClassificationSource;
}

export interface ClassificationOutcome {
  category: string | null;
  type: string | null;
  state: ClassificationState;
  categoryUserLocked: boolean;
  typeUserLocked: boolean;
  /** Ce que la règle a fait, pour l'historique du §5.3. */
  changes: string[];
  /** Modifications refusées, et pourquoi. */
  rejected: string[];
}

/**
 * Applique une modification de classement.
 *
 * Implémente les sept lignes du §4.3 et les verrouillages du §5.2.
 *
 * ── LES TROIS RÈGLES QUI RETIRENT UNE VALEUR ──────────────────────────────
 *
 * Elles peuvent surprendre, et méritent d'être nommées :
 *
 *   · « Catégorie modifiée et type devenu incompatible » → le type est retiré ;
 *   · « Type modifié et catégorie devenue incompatible » → la catégorie est
 *     retirée, SAUF attribution automatique si une seule catégorie convient ;
 *   · dans les deux cas, le document repasse « À classer ».
 *
 * L'alternative — refuser la modification — bloquerait l'utilisateur dans un
 * état qu'il cherche justement à corriger. Retirer la valeur devenue fausse et
 * l'afficher comme « à classer » est plus honnête qu'un couple incohérent
 * présenté comme classé.
 */
export function applyClassification(
  input: ClassificationInput,
  index: CompatibilityIndex,
): ClassificationOutcome {
  const changes: string[] = [];
  const rejected: string[] = [];

  let category = input.currentCategory;
  let type = input.currentType;
  let categoryLocked = input.categoryUserLocked ?? false;
  let typeLocked = input.typeUserLocked ?? false;

  const byUser = input.source === 'USER';
  const categoryTouched = input.nextCategory !== undefined;
  const typeTouched = input.nextType !== undefined;

  // ── Verrouillages (§5.2) ────────────────────────────────────────────────
  //
  // « Une catégorie corrigée manuellement ne peut plus être changée par
  //   l'IA. Un type corrigé manuellement ne peut plus être changé par l'IA,
  //   sauf si sa valeur est "Autre" et qu'un type précis devient disponible. »
  const aiBlockedOnCategory = !byUser && categoryLocked;
  const aiBlockedOnType =
    !byUser && typeLocked && type !== GENERIC_TYPE_CODE;

  if (categoryTouched) {
    if (aiBlockedOnCategory) {
      rejected.push('Catégorie verrouillée par une correction manuelle.');
    } else {
      if (category !== input.nextCategory) {
        changes.push(`Catégorie : ${category ?? '—'} → ${input.nextCategory ?? '—'}`);
      }
      category = input.nextCategory ?? null;
      if (byUser) categoryLocked = true;
    }
  }

  if (typeTouched) {
    if (aiBlockedOnType) {
      rejected.push('Type verrouillé par une correction manuelle.');
    } else {
      if (type !== input.nextType) {
        changes.push(`Type : ${type ?? '—'} → ${input.nextType ?? '—'}`);
      }
      type = input.nextType ?? null;
      if (byUser) typeLocked = true;
    }
  }

  // ── Attribution automatique (§4.3, ligne 1) ─────────────────────────────
  //
  // « Type compatible avec une seule catégorie : la catégorie est attribuée
  //   automatiquement lorsque le type est choisi. »
  if (type && !category) {
    const candidates = index.categoriesForType(type);
    if (candidates.length === 1) {
      category = candidates[0];
      changes.push(`Catégorie attribuée automatiquement : ${category}`);
    }
  }

  // ── Retrait des valeurs devenues incompatibles (§4.3, lignes 5 et 6) ────
  if (category && type && !index.isCompatible(type, category)) {
    if (categoryTouched && !typeTouched) {
      // La catégorie vient de changer : c'est le type qui est devenu faux.
      changes.push(`Type ${type} retiré : incompatible avec ${category}`);
      type = null;
      typeLocked = false;
    } else if (typeTouched && !categoryTouched) {
      const candidates = index.categoriesForType(type);
      if (candidates.length === 1) {
        changes.push(`Catégorie remplacée automatiquement : ${category} → ${candidates[0]}`);
        category = candidates[0];
      } else {
        changes.push(`Catégorie ${category} retirée : incompatible avec ${type}`);
        category = null;
        categoryLocked = false;
      }
    } else {
      // Les deux ont bougé, ou aucun : on retire le type, choix le moins
      // destructeur — la catégorie porte la navigation et les compteurs.
      changes.push(`Type ${type} retiré : incompatible avec ${category}`);
      type = null;
      typeLocked = false;
    }
  }

  // ── Catégorie hors du périmètre des biens rattachés (§4.4) ──────────────
  //
  // « Les catégories et types proposés doivent être compatibles avec tous les
  //   biens associés. » Une catégorie devenue inapplicable — parce que le
  //   document a été rattaché à un bien d'une autre famille — est retirée.
  if (category && !index.categoriesForAssets().includes(category)) {
    changes.push(`Catégorie ${category} retirée : inapplicable aux biens rattachés`);
    category = null;
    categoryLocked = false;
  }

  return {
    category,
    type,
    state: computeClassificationState(category, type, index),
    categoryUserLocked: categoryLocked,
    typeUserLocked: typeLocked,
    changes,
    rejected,
  };
}

/**
 * L'IA peut-elle remplacer un type générique par un type précis ?
 *
 * §5.2, exception explicite : « sauf si sa valeur est "Autre" et qu'un type
 * précis devient disponible ». Et §4.2 : le traitement de cohérence peut
 * remplacer « Autre » lorsqu'un nouveau type est créé.
 *
 * C'est la seule circonstance où l'IA passe outre un verrouillage utilisateur,
 * et elle se justifie : l'utilisateur qui a choisi « Autre » n'a pas exprimé
 * une préférence, il a constaté une absence.
 */
export function canAiRefineType(
  currentType: string | null,
  typeUserLocked: boolean,
  proposedType: string,
): boolean {
  if (proposedType === GENERIC_TYPE_CODE) return false;
  if (!typeUserLocked) return true;
  return currentType === GENERIC_TYPE_CODE;
}
