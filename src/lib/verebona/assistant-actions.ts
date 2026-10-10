/**
 * Exécution des actions de l'assistant — lot 34G (ticket « T2 Aide
 * produit », §3 et §4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DISPATCHER, QUATRE FAMILLES
 *
 *   NAVIGATION    page de l'application ou article d'aide (`href`) ;
 *   OPEN_ENTITY   fiche d'un objet du compte (`href`, tiroir si possible) ;
 *   CREATE        parcours de création ouvert DIRECTEMENT
 *                 (START_ADD_DOCUMENT → UnifiedDocumentDialog,
 *                 START_ADD_ASSET → AssetFormDialog,
 *                 START_ADD_AGENDA_ITEM → CreateAgendaItemDrawer) ;
 *   ASSISTANT_UI  action interne à l'espace (explication, réessai).
 *
 * Avant, les trois START_ADD_* portaient un `href` (/documents, /assets,
 * /agenda) utilisé comme une commande : un clic menait à une page où il
 * fallait retrouver le bouton. Une création n'a plus de `href` : le serveur
 * envoie une COMMANDE (`command`, parcours + bien déjà contrôlé), et ce
 * module décide par la FAMILLE de l'action, jamais par la forme d'une URL.
 * Une nouvelle action de création = une entrée dans `CREATE_ACTION_FLOWS`,
 * pas un cas de plus dans l'interface.
 *
 * Le module est pur (aucune dépendance au navigateur ni au serveur) : le
 * serveur s'en sert pour construire la commande, le client pour l'exécuter.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CreateFlowKind } from '@/lib/create-flows';

export type AssistantActionKind = 'NAVIGATION' | 'OPEN_ENTITY' | 'CREATE' | 'ASSISTANT_UI';

/** Actions de création et parcours ouvert par chacune. */
export const CREATE_ACTION_FLOWS: Readonly<Record<string, CreateFlowKind>> = {
  START_ADD_DOCUMENT: 'document',
  START_ADD_ASSET: 'asset',
  START_ADD_AGENDA_ITEM: 'agenda_item',
};

const OPEN_ENTITY_TYPES = new Set(['OPEN_ASSET', 'OPEN_DOCUMENT', 'OPEN_AGENDA_ITEM', 'OPEN_SUPPLIER']);
const ASSISTANT_UI_TYPES = new Set(['SHOW_SOURCES', 'SHOW_EXPLANATION', 'RETRY_REQUEST']);

/** Famille d'une action, par son type (pure). */
export function assistantActionKind(type: string): AssistantActionKind {
  if (CREATE_ACTION_FLOWS[type]) return 'CREATE';
  if (ASSISTANT_UI_TYPES.has(type)) return 'ASSISTANT_UI';
  if (OPEN_ENTITY_TYPES.has(type)) return 'OPEN_ENTITY';
  return 'NAVIGATION';
}

/** Commande d'une action de création : parcours, et bien présélectionné. */
export interface AssistantCreateCommand {
  kind: 'CREATE';
  flow: CreateFlowKind;
  /** Bien résolu ET contrôlé par le serveur (appartenance au compte). */
  assetId: number | null;
}

/**
 * Commande d'une action de création à partir de sa cible contrôlée
 * (« asset:42 »), ou `null` si l'action n'est pas une création (pure —
 * utilisée par le résolveur et par la relecture de l'historique).
 */
export function createCommandFor(type: string, targetRef?: string | null): AssistantCreateCommand | null {
  const flow = CREATE_ACTION_FLOWS[type];
  if (!flow) return null;
  const m = /^asset:(\d{1,10})$/.exec(String(targetRef ?? ''));
  const id = m ? Number(m[1]) : null;
  // Un bien n'est jamais présélectionné pour… créer un bien.
  return { kind: 'CREATE', flow, assetId: flow !== 'asset' && id && Number.isSafeInteger(id) ? id : null };
}

/** Forme minimale d'une action reçue par le client. */
export interface AssistantActionLike {
  type: string;
  href: string | null;
  command?: AssistantCreateCommand | null;
}

export interface AssistantActionHandlers {
  /** Navigation (page, article, fiche) ; `kind` distingue une fiche d'une page. */
  navigate(href: string, kind: 'NAVIGATION' | 'OPEN_ENTITY'): void;
  /** Ouverture directe d'un parcours de création. */
  create(command: AssistantCreateCommand): void;
  /** Action interne à l'espace de l'assistant. */
  assistantUi(type: string): void;
}

/**
 * Exécute une action selon sa famille. Rend la famille exécutée, ou `null`
 * si l'action ne peut rien faire (navigation sans `href`).
 *
 * Une création ne navigue JAMAIS, même si une ancienne réponse enregistrée
 * porte encore un `href` (/documents, /assets, /agenda) : sa commande est
 * reconstruite à partir de son type.
 */
export function executeAssistantAction(action: AssistantActionLike, handlers: AssistantActionHandlers): AssistantActionKind | null {
  const kind = assistantActionKind(action.type);
  switch (kind) {
    case 'CREATE':
      handlers.create(action.command?.kind === 'CREATE' ? action.command : createCommandFor(action.type)!);
      return kind;
    case 'ASSISTANT_UI':
      handlers.assistantUi(action.type);
      return kind;
    default:
      if (!action.href) return null;
      handlers.navigate(action.href, kind);
      return kind;
  }
}
