/**
 * Éléments « À traiter » de la mascotte — lot 32, ticket « Mascotte :
 * simplifier la hiérarchie des À traiter et ouvrir directement l'action
 * utile » (MASC2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX NIVEAUX, UNE SEULE SOURCE
 *
 * Avant : un texte qui détaillait les sujets (« Quel est le numéro
 * d'immatriculation de ce bien ? Cela concerne… »), des tuiles « Vérifier
 * l'information », puis des pastilles « Compléter “…” » / « Choisir “…” » —
 * trois niveaux pour les mêmes actions, et un clic qui menait à
 * l'espace de réponse ou en haut de la page « À traiter ».
 *
 * Désormais :
 *   · niveau 1 — une phrase courte qui COMPTE les sujets (même total que la
 *     pastille du menu et que la page : `getToProcessPage().total`) ;
 *   · niveau 2 — un élément homogène par action, construit ICI à partir des
 *     lignes rendues par le service de la file (même ordre « Par
 *     priorité », mêmes propositions affichées), jamais d'une logique propre.
 *
 * ── CONTRAT STRUCTURÉ (jamais déduit d'un libellé) ────────────────────────
 *
 *   todoId, todoType (règle), entityType, entityId, actionType ;
 *   availableChoices, targetField, documentId, assetId lorsque pertinents.
 *
 *   actionType :
 *     · OPEN_CHOICES   — arbitrage avec AU MOINS DEUX propositions
 *                         exploitables : le composant de choix de la file
 *                         (`ActionCard`) s'ouvre directement ;
 *     · OPEN_TODO_CARD — tout le reste (saisie, une seule proposition, aucune
 *                         proposition, contrôle) : la carte de la file,
 *                         ciblée par son ID, ouverte et positionnée.
 *   Un seul choix ne produit jamais de sélecteur : la carte s'ouvre et
 *   montre la valeur pour confirmation (aucune application automatique).
 *
 * `card` porte la vue de l'action telle que la file l'affiche : la mascotte
 * réutilise la carte et la résolution de « À traiter » sans relecture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import type { MascotTodoBlock, MascotTodoItem } from './types';

/** Éléments « À traiter » affichés au plus (le reste : « Tout voir »). */
export const MAX_TODO_ITEMS = 3;

/**
 * Nom de la donnée visée, par règle (catalogue `PROCESSING_RULES`). Phrase
 * complète (`fixed`) quand le verbe ne s'ajoute pas naturellement.
 */
const SUJETS: Readonly<Record<string, { noun: string; fixed?: string }>> = {
  'DOC-RUB': { noun: 'Rubrique du document' },
  'DOC-TYP': { noun: 'Type de document' },
  'LINK-ASSET': { noun: 'Bien du document', fixed: 'Document à rattacher à un bien' },
  'LINK-ELT': { noun: 'Pièce ou équipement du document', fixed: 'Document à rattacher à une pièce ou un équipement' },
  'DATA-CONTRACT-END': { noun: 'Date de fin de contrat' },
  'DATA-WARRANTY-END': { noun: 'Date de fin de garantie' },
  'DATA-AGENDA-DATE': { noun: 'Date de l’échéance' },
  'AGENDA-DUPLICATE': { noun: 'Échéance en double', fixed: 'Échéance en double à vérifier' },
  'DATA-REGISTRATION': { noun: 'Numéro d’immatriculation' },
  'DATA-ACQUISITION-PRICE': { noun: 'Prix d’acquisition' },
  'DATA-SUPPLIER': { noun: 'Fournisseur du document' },
  'LINK-EQUIP-ASSET': { noun: 'Bien de l’équipement', fixed: 'Équipement à rattacher à un bien' },
  'SUPPLIER-IDENTITY': { noun: 'Fournisseur', fixed: 'Fournisseur à confirmer' },
  'AGENDA-DONE': { noun: 'Échéance', fixed: 'Échéance réalisée à confirmer' },
  'AGENDA-NOT-DONE': { noun: 'Échéance', fixed: 'Échéance non réalisée à vérifier' },
  'AGENDA-PROPOSAL': { noun: 'Échéance', fixed: 'Échéance à ajouter à l’agenda' },
  'MIG-REVIEW': { noun: 'Valeur', fixed: 'Valeur à choisir' },
  'ENTITY-FIELD': { noun: 'Valeur', fixed: 'Valeur d’équipement à choisir' },
  'ENTITY-FIELD-ROOM': { noun: 'Valeur', fixed: 'Valeur de pièce à choisir' },
  'ASSET-STATUS': { noun: 'Statut du bien', fixed: 'Statut du bien à confirmer' },
};

/** « Numéro d’immatriculation à vérifier », « Information à compléter »… (pure). */
export function todoTitle(ruleCode: string, actionKind: string): string {
  const s = SUJETS[ruleCode];
  if (s?.fixed) return s.fixed;
  const nom = s?.noun ?? 'Information';
  return `${nom} à ${actionKind === 'ARBITRATE' ? 'vérifier' : 'compléter'}`;
}

/** Action à proposer d'après la vue de la file (pure). */
export function todoActionType(a: Pick<ToProcessActionView, 'actionKind' | 'proposals'>): MascotTodoItem['actionType'] {
  const exploitables = a.proposals.filter((p) => p.value !== null && p.value !== undefined && String(p.value).trim() !== '');
  return a.actionKind === 'ARBITRATE' && exploitables.length >= 2 ? 'OPEN_CHOICES' : 'OPEN_TODO_CARD';
}

function cta(a: ToProcessActionView, type: MascotTodoItem['actionType']): string {
  if (type === 'OPEN_CHOICES') {
    if (a.ruleCode === 'LINK-ASSET' || a.ruleCode === 'LINK-EQUIP-ASSET') return 'Choisir le bien';
    return 'Vérifier';
  }
  return a.actionKind === 'ARBITRATE' ? 'Vérifier' : 'Compléter';
}

/** Élément de niveau 2, à partir d'une ligne du service de la file (pure). */
export function todoItemFrom(a: ToProcessActionView): MascotTodoItem {
  const actionType = todoActionType(a);
  const cible = a.target.label;
  const bien = a.target.assetName && a.target.assetName !== cible ? a.target.assetName : null;
  const field = a.fieldKey ?? a.relationKey ?? null;
  return {
    todoId: a.publicId,
    todoType: a.ruleCode,
    entityType: a.targetType,
    entityId: a.targetId,
    actionType,
    ...(actionType === 'OPEN_CHOICES'
      ? { availableChoices: a.proposals.map((p) => ({ value: p.value, label: p.label, ...(p.isCurrentValue ? { isCurrentValue: true } : {}) })) }
      : {}),
    targetField: field,
    documentId: a.targetType === 'DOCUMENT' ? a.targetId : null,
    assetId: a.targetType === 'ASSET' ? a.targetId : (a.target.assetId ?? null),
    priority: a.priority,
    actionKind: a.actionKind,
    title: todoTitle(a.ruleCode, a.actionKind),
    subtitle: bien ? `${cible} · ${bien}` : cible,
    cta: cta(a, actionType),
    card: {
      publicId: a.publicId, targetType: a.targetType, targetId: a.targetId,
      fieldKey: a.fieldKey, relationKey: a.relationKey, actionKind: a.actionKind,
      priority: a.priority, ruleCode: a.ruleCode, question: a.question,
      // Mêmes propositions que la carte de la file (déjà sélectionnées par
      // le service) ; ni score ni preuve transmis.
      proposals: a.proposals.map((p) => ({
        value: p.value, label: p.label,
        ...(p.isCurrentValue ? { isCurrentValue: true } : {}),
        ...(p.sourceContext?.label ? { sourceContext: { label: p.sourceContext.label } } : {}),
      })),
      inputType: a.inputType ?? null,
      target: {
        label: a.target.label, mimeType: a.target.mimeType ?? null, publicId: a.target.publicId ?? null,
        assetId: a.target.assetId ?? null, assetName: a.target.assetName ?? null, supplierId: a.target.supplierId ?? null,
      },
    },
  };
}

/**
 * Bloc « À traiter » de la mascotte : total de la file (= pastille, = page)
 * et ses premiers éléments, dans l'ordre du service. `null` : file illisible.
 */
export function buildTodoBlock(
  actions: ToProcessActionView[] | null,
  total: number | null | undefined,
  max = MAX_TODO_ITEMS,
): MascotTodoBlock | null {
  if (!actions) return null;
  return {
    total: Math.max(total ?? actions.length, actions.length),
    items: actions.slice(0, max).map(todoItemFrom),
  };
}
