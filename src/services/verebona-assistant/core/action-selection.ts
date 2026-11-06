/**
 * Sélection des actions de l'assistant — lot 113F (#689).
 *
 * ── CONSTAT ───────────────────────────────────────────────────────────────
 * « Quelle est ma prochaine échéance ? » affichait « Ouvrir l'agenda »,
 * « Voir dans l'agenda », « Voir dans l'agenda » : trois boutons vers la même
 * page, aucun vers l'échéance présentée. Trois défauts réunis :
 *   A. une action était proposée pour chaque source RÉCUPÉRÉE, et non pour
 *      les éléments réellement présentés par la réponse ;
 *   B. la déduplication portait sur « type + cible » : deux types différents
 *      vers la même destination passaient tous les deux ;
 *   C. OPEN_AGENDA_ITEM menait à `/agenda` au lieu du tiroir de l'échéance.
 *
 * ── RÈGLE GÉNÉRALE (aucun cas particulier par question ni par rubrique) ──
 *   1. Éléments présentés : les sources citées par les affirmations de la
 *      réponse (association affirmation ↔ source déjà produite par chaque
 *      stratégie) ; sans affirmation citant une source affichée, toutes les
 *      sources affichées. Une action d'ouverture d'objet n'est proposée que
 *      pour un élément présenté.
 *   2. Une action par destination effective (même `href`) : la première, la
 *      plus prioritaire, est gardée.
 *   3. « Voir les résultats » : gardé seulement quand les boutons individuels
 *      ne peuvent pas couvrir tous les éléments de la liste (plus d'éléments
 *      que la limite d'affichage) ; il remplace alors ces boutons.
 *   4. Une navigation générale (agenda, documents, fournisseurs) est retirée
 *      quand une action contextuelle de la même rubrique répond déjà au besoin.
 *   5. Limite existante du §22.9 : 1 principale + 2 secondaires (actions
 *      métier), appliquée APRÈS la sélection — jamais de remplissage.
 *
 * Fonctions pures, testées ; aucun accès en base (les contrôles de cible,
 * d'appartenance au compte, de droits et d'offre restent dans le résolveur).
 */
import type { Claim } from '../types/sources';
import type { VerebonaAction, VerebonaActionType } from '../types/actions';
import { getActionDefinition } from '../registries/action-registry';

/** Limite du §22.9 : 1 action principale + 2 secondaires (actions métier). */
export const MAX_ACTIONS_METIER = 3;

/** Clé de payload (serveur seulement) : sources d'origine d'une action, séparées par `|`. */
export const PAYLOAD_SOURCES = 'sourceIds';

type Rubrique = 'agenda' | 'documents' | 'suppliers' | 'assets';

/** Ouverture d'un OBJET précis du compte (fiche, tiroir). */
const CONTEXTUELLES: Readonly<Partial<Record<VerebonaActionType, Rubrique>>> = {
  OPEN_AGENDA_ITEM: 'agenda',
  OPEN_DOCUMENT: 'documents',
  OPEN_SUPPLIER: 'suppliers',
  OPEN_ASSET: 'assets',
};

/** Navigation GÉNÉRALE vers une rubrique entière. */
const GENERALES: Readonly<Partial<Record<VerebonaActionType, Rubrique>>> = {
  OPEN_AGENDA: 'agenda',
  OPEN_DOCUMENTS_PAGE: 'documents',
  OPEN_SUPPLIERS: 'suppliers',
};

export function rubriqueContextuelle(type: VerebonaActionType): Rubrique | null {
  return CONTEXTUELLES[type] ?? null;
}

/** Rubrique couverte par « Voir les résultats » (portée scellée dans le jeton). */
function rubriqueResultats(a: Pick<VerebonaAction, 'type' | 'payload'>): Rubrique | null {
  if (a.type !== 'OPEN_SEARCH_RESULTS') return null;
  const scope = a.payload?.scope;
  return scope === 'agenda' ? 'agenda' : scope === 'documents' ? 'documents' : null;
}

/** Sources d'origine d'une action (vide : action sans source — repli, contexte de page). */
export function sourcesDeLAction(a: Pick<VerebonaAction, 'payload'>): string[] {
  const v = a.payload?.[PAYLOAD_SOURCES];
  return typeof v === 'string' && v ? v.split('|') : [];
}

/** Ajoute des sources d'origine à une action (fusion lors d'une déduplication). */
export function ajouterSources(a: VerebonaAction, ids: readonly string[]): VerebonaAction {
  const tous = [...new Set([...sourcesDeLAction(a), ...ids.filter(Boolean)])];
  if (!tous.length) return a;
  return { ...a, payload: { ...(a.payload ?? {}), [PAYLOAD_SOURCES]: tous.join('|') } };
}

/**
 * Identifiants des éléments PRÉSENTÉS par la réponse (pure).
 *
 * Les sources citées par au moins une affirmation, parmi les sources
 * fournies ; aucune citation exploitable : toutes les sources fournies.
 * `null` quand aucune source n'est fournie (rien à restreindre).
 */
export function idsPresentes(
  claims: ReadonlyArray<Pick<Claim, 'sourceIds'>> | null | undefined,
  sources: ReadonlyArray<{ id: string }>,
): Set<string> | null {
  if (!sources.length) return null;
  const fournis = new Set(sources.map((s) => s.id));
  const cites = new Set((claims ?? []).flatMap((c) => c.sourceIds ?? []).filter((id) => fournis.has(id)));
  return cites.size ? cites : fournis;
}

/** Action métier (compte dans la limite du §22.9). */
function estMetier(type: VerebonaActionType): boolean {
  try { return getActionDefinition(type).isBusinessAction; } catch { return false; }
}

/** Destination effective d'une action : son `href`, sinon type + cible + commande. */
export function destinationDe(a: Pick<VerebonaAction, 'type' | 'href' | 'targetRef' | 'payload'>): string {
  if (a.href && a.type !== 'OPEN_SEARCH_RESULTS') return `href:${a.href.split('#')[0]}`;
  if (a.type === 'OPEN_SEARCH_RESULTS') return `results:${String(a.payload?.scope ?? '')}:${String(a.payload?.ids ?? '')}`;
  return `${a.type}:${a.targetRef ?? ''}`;
}

/**
 * Sélection définitive (pure, idempotente) — règles 2 à 5 ci-dessus.
 * L'ordre d'entrée fait foi : la première action métier gardée est la principale.
 */
export function selectionnerActions(actions: readonly VerebonaAction[]): VerebonaAction[] {
  // 2. Une action par destination effective (sources d'origine fusionnées).
  const parDestination = new Map<string, number>();
  let liste: VerebonaAction[] = [];
  for (const a of actions) {
    const cle = destinationDe(a);
    const deja = parDestination.get(cle);
    if (deja != null) { liste[deja] = ajouterSources(liste[deja], sourcesDeLAction(a)); continue; }
    parDestination.set(cle, liste.length);
    liste.push(a);
  }

  // 3. « Voir les résultats » face aux boutons individuels de sa rubrique :
  //    liste plus longue que la limite → la liste seule ; sinon, si chaque
  //    élément a déjà son bouton, la liste est redondante. Décision lue sur
  //    les identifiants scellés (idempotente).
  const individuels = (r: Rubrique) => liste.filter((a) => rubriqueContextuelle(a.type) === r).length;
  const retirer = new Set<VerebonaAction>();
  for (const a of liste) {
    const r = rubriqueResultats(a);
    if (!r) continue;
    const elements = String(a.payload?.ids ?? '').split(',').filter(Boolean).length;
    if (elements > MAX_ACTIONS_METIER) {
      for (const b of liste) if (rubriqueContextuelle(b.type) === r) retirer.add(b);
    } else if (individuels(r) >= elements) {
      retirer.add(a);
    }
  }
  liste = liste.filter((a) => !retirer.has(a));

  // 4. Navigation générale couverte par une action contextuelle de sa rubrique.
  const couvertes = new Set<Rubrique>();
  for (const a of liste) {
    const r = rubriqueContextuelle(a.type) ?? rubriqueResultats(a);
    if (r) couvertes.add(r);
  }
  liste = liste.filter((a) => {
    const r = GENERALES[a.type];
    return !r || !couvertes.has(r);
  });

  // 5. Limite du §22.9, après la sélection.
  let metier = 0;
  return liste.filter((a) => {
    if (!estMetier(a.type)) return true;
    metier += 1;
    return metier <= MAX_ACTIONS_METIER;
  });
}

/**
 * Restreint les actions aux éléments PRÉSENTÉS par la réponse finale (pure).
 *
 * Seules les actions issues de sources (`sourceIds`) sont concernées : une
 * action dont aucune source d'origine n'est présentée est retirée. Les actions
 * sans source (navigation générale, contexte de page, création, interface)
 * sont conservées, puis la sélection est réappliquée.
 *
 * `presentes` null : aucune restriction (réponse construite sans source).
 */
export function retenirActionsPresentees(
  actions: readonly VerebonaAction[],
  presentes: ReadonlySet<string> | null,
): VerebonaAction[] {
  if (!presentes) return selectionnerActions(actions);
  return selectionnerActions(actions.filter((a) => {
    const ids = sourcesDeLAction(a);
    return ids.length === 0 || ids.some((id) => presentes.has(id));
  }));
}
