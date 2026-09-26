/**
 * Résolveur d'actions — CDC §22.6 / §22.7 / §22.9.
 *
 * À partir d'`ActionIntent` (type + cible), le SERVEUR :
 *  - vérifie que le type est autorisé pour l'intention ;
 *  - décode la cible, vérifie qu'elle est du BON type et qu'elle appartient
 *    au compte ;
 *  - génère actionId, label lisible, href interne, expiration et code analytics.
 *
 * Le href N'EST JAMAIS fourni par le modèle (§22.1). Les URLs sont construites
 * ici à partir des routes réelles de l'app, centralisées dans `entity-ref.ts`.
 *
 * ── CE QUI A CHANGÉ, ET POURQUOI ─────────────────────────────────────────
 * Le contrôle « account_object » interrogeait successivement les quatre
 * vérificateurs et acceptait dès que l'un répondait vrai. Deux conséquences :
 *  1. un identifiant de document pouvait autoriser un OPEN_ASSET, et produire
 *     un lien vers une fiche de bien qui n'a rien à voir ;
 *  2. le coût était de quatre requêtes là où le type de l'action désigne sans
 *     ambiguïté la table à interroger.
 *
 * Le contrôle est désormais dirigé par le type : chaque action déclare la
 * famille d'entité qu'elle cible, et une cible d'une autre famille est un refus,
 * pas une occasion d'essayer ailleurs.
 */
import { randomUUID } from 'crypto';
import type { ActionIntent, VerebonaAction, VerebonaActionType } from '../types/actions';
import type { VerebonaIntent } from '../types/intents';
import { getActionDefinition, allowedActionsFor } from '../registries/action-registry';
import { HELP_CONTACT_PATH, integratedHelpHref, isHelpPath } from '@/lib/help-center/open';
import {
  parseEntityRef, hrefBien, ROUTES,
  type EntityKind, type EntityRef, type OngletBien,
} from './entity-ref';

/**
 * Vérificateurs d'appartenance au compte (§22.7).
 *
 * Les identifiants sont NUMÉRIQUES : le décodage du préfixe a lieu avant
 * l'appel, pour qu'aucune chaîne venue du modèle n'atteigne une requête.
 */
export interface AccessChecker {
  assetInAccount(accountId: number, assetId: number): Promise<boolean>;
  documentInAccount(accountId: number, documentId: number): Promise<boolean>;
  agendaItemInAccount(accountId: number, agendaItemId: number): Promise<boolean>;
  helpEntryPublished(slug: string): Promise<boolean>;
}

/**
 * Famille d'entité attendue par chaque action à cible.
 *
 * Une action absente de cette table n'attend pas de cible : lui en fournir une
 * est sans effet, ne pas lui en fournir n'est pas une erreur.
 */
export const CIBLE_ATTENDUE: Readonly<Partial<Record<VerebonaActionType, EntityKind>>> = {
  OPEN_ASSET: 'asset',
  OPEN_DOCUMENT: 'document',
  OPEN_AGENDA_ITEM: 'agenda_item',
  START_ADD_DOCUMENT: 'asset',
  START_ADD_AGENDA_ITEM: 'asset',
  OPEN_EXPORT_AREA: 'asset',
};

/**
 * Actions dont la cible est FACULTATIVE (§22.9, CA-14, 37.15).
 *
 * « Comment ajouter un document ? » doit proposer « Ajouter un document »
 * même sans bien désigné : l'action exigeait une cible bien et disparaissait,
 * alors que « Ajouter un bien » apparaissait. Sans cible, elles mènent à la
 * page où l'ajout se fait (documents, agenda) ; avec une cible, la cible est
 * contrôlée comme avant (famille, appartenance au compte).
 */
export const CIBLE_FACULTATIVE: ReadonlySet<VerebonaActionType> = new Set<VerebonaActionType>([
  'START_ADD_DOCUMENT',
  'START_ADD_AGENDA_ITEM',
]);

/** Vrai si l'action n'a de sens qu'avec une cible résolue. */
export function exigeUneCible(type: VerebonaActionType): boolean {
  return CIBLE_ATTENDUE[type] != null && !CIBLE_FACULTATIVE.has(type);
}

/** Onglet de la fiche bien ouvert par une action, quand elle en vise un. */
const ONGLET_PAR_ACTION: Readonly<Partial<Record<VerebonaActionType, OngletBien>>> = {
  START_ADD_DOCUMENT: 'documents',
  START_ADD_AGENDA_ITEM: 'agenda',
  OPEN_EXPORT_AREA: 'exports',
};

/**
 * Construit les href internes à partir des routes réelles (§22.7).
 *
 * `ref` est déjà décodée et contrôlée : si elle est nulle pour une action qui
 * exige une cible, il n'y a pas d'URL à produire.
 */
function buildHref(
  type: VerebonaActionType,
  ref: EntityRef | null,
  params?: Record<string, unknown>,
): string | null {
  switch (type) {
    case 'OPEN_ASSET': {
      if (!ref) return null;
      // `tab` est posé par le serveur uniquement (équipement ou pièce ouverts
      // sur l'onglet du bien parent) ; une valeur inconnue est ignorée.
      const onglet = typeof params?.tab === 'string' ? (params.tab as OngletBien) : undefined;
      return hrefBien(ref.id, onglet);
    }
    case 'OPEN_DOCUMENT':
      return ref ? `${ROUTES.DOCUMENTS}/${ref.id}` : null;
    case 'OPEN_DOCUMENTS_PAGE':
      return ROUTES.DOCUMENTS;
    // L'agenda n'a pas de page de détail : `/agenda/[id]` n'existe pas, le
    // détail s'ouvre dans un tiroir. On amène l'utilisateur à l'agenda plutôt
    // que sur un 404.
    case 'OPEN_AGENDA':
    case 'OPEN_AGENDA_ITEM':
      return ROUTES.AGENDA;
    case 'OPEN_TO_PROCESS':
      return ROUTES.A_TRAITER;
    case 'OPEN_ACCOUNT':
      return ROUTES.COMPTE;
    case 'OPEN_PRICING':
      return ROUTES.OFFRES;
    // Lien profond vers l'ARTICLE (audit P2 « lien d'aide vers l'article
    // précis ») : le Centre d'aide intégré lit `?page=/aide/<slug>`
    // (`integratedHelpHref`). L'ancien commentaire (« pas de lien profond »)
    // était devenu faux. `path` est posé par le serveur depuis le corpus,
    // jamais par le modèle, et revalidé ici (`isHelpPath`).
    case 'OPEN_HELP': {
      const path = typeof params?.path === 'string' ? params.path.split('#')[0] : '';
      return path && isHelpPath(path) ? integratedHelpHref(path) : ROUTES.AIDE;
    }
    case 'OPEN_CONTACT':
      return integratedHelpHref(HELP_CONTACT_PATH);
    // La création d'un bien se fait par une boîte de dialogue depuis la liste,
    // il n'existe pas de page `/assets/nouveau`.
    case 'START_ADD_ASSET':
      return ROUTES.BIENS;
    // Sans bien désigné : la page où l'ajout se fait (les pages n'exposent
    // pas de paramètre d'ouverture directe du formulaire — pas d'URL devinée).
    case 'START_ADD_DOCUMENT':
      return ref ? hrefBien(ref.id, ONGLET_PAR_ACTION[type]) : ROUTES.DOCUMENTS;
    case 'START_ADD_AGENDA_ITEM':
      return ref ? hrefBien(ref.id, ONGLET_PAR_ACTION[type]) : ROUTES.AGENDA;
    case 'OPEN_EXPORT_AREA':
      return ref ? hrefBien(ref.id, ONGLET_PAR_ACTION[type]) : null;
    case 'OPEN_SEARCH_RESULTS':
      return null; // via jeton signé (résolu par la route dédiée)
    case 'SHOW_SOURCES':
    case 'SHOW_EXPLANATION':
    case 'RETRY_REQUEST':
      return null; // actions UI internes, pas de navigation
    default:
      return null;
  }
}

const LABELS: Record<VerebonaActionType, string> = {
  OPEN_ASSET: 'Ouvrir le bien', OPEN_DOCUMENT: 'Ouvrir le document',
  OPEN_DOCUMENTS_PAGE: 'Voir les documents', OPEN_SEARCH_RESULTS: 'Voir les résultats',
  OPEN_AGENDA: "Ouvrir l'agenda", OPEN_AGENDA_ITEM: "Voir dans l'agenda",
  OPEN_TO_PROCESS: 'Ouvrir « À traiter »', OPEN_SUPPLIERS: 'Voir les fournisseurs',
  OPEN_SUPPLIER: 'Ouvrir le fournisseur', OPEN_ACCOUNT: 'Ouvrir mon compte',
  OPEN_PRICING: 'Voir les offres', OPEN_HELP: "Consulter l'aide", OPEN_CONTACT: 'Contacter le support',
  START_ADD_ASSET: 'Ajouter un bien', START_ADD_DOCUMENT: 'Ajouter un document',
  START_ADD_AGENDA_ITEM: 'Créer une échéance', OPEN_EXPORT_AREA: 'Préparer un export',
  SHOW_SOURCES: 'Voir les sources', SHOW_EXPLANATION: 'Pourquoi cette réponse ?',
  RETRY_REQUEST: 'Réessayer',
};

export interface ResolveActionsInput {
  accountId: number;
  intent: VerebonaIntent;
  actionIntents: ActionIntent[];
  messageId?: string;
  access: AccessChecker;
}

/**
 * Résout et filtre les actions proposées (§22.6-22.7).
 *
 * L'ordre d'entrée fait foi : la première action métier retenue est la
 * principale, les suivantes sont secondaires. La limite du §22.9 (1 principale
 * + 2 secondaires) est appliquée sur les actions métier uniquement.
 */
export async function resolveActions(input: ResolveActionsInput): Promise<VerebonaAction[]> {
  const allowed = new Set(allowedActionsFor(input.intent));
  const out: VerebonaAction[] = [];
  const vues = new Set<string>();
  let businessCount = 0;

  for (const ai of input.actionIntents) {
    if (!allowed.has(ai.type)) continue;
    const def = getActionDefinition(ai.type);

    // Un même bien remonté par plusieurs sources (le bien lui-même, une de ses
    // pièces, un de ses équipements) ne doit pas produire trois fois le même
    // bouton — et surtout pas consommer trois fois le quota du §22.9.
    const cle = `${ai.type}:${ai.targetId ?? ''}:${ai.params?.tab ?? ''}`;
    if (vues.has(cle)) continue;

    if (def.isBusinessAction && businessCount >= 3) continue;

    // ── Décodage de la cible (§18.4) ────────────────────────────────────
    // Le type de l'action impose la famille attendue. Une cible d'une autre
    // famille — ou fabriquée — donne `null`, donc un refus.
    const attendu = CIBLE_ATTENDUE[ai.type];
    // Cible facultative ABSENTE : action sans cible, aucun contrôle d'objet.
    // Cible fournie (même pour une action facultative) : contrôlée comme
    // toujours — une cible fabriquée reste un refus.
    const sansCible = CIBLE_FACULTATIVE.has(ai.type) && (ai.targetId == null || ai.targetId === '');
    const ref = attendu && !sansCible ? parseEntityRef(ai.targetId, attendu) : null;
    if (attendu && !sansCible && !ref) continue;

    const slug = ai.targetId != null ? String(ai.targetId) : undefined;
    const authorized = sansCible || await checkAccess(input.accountId, def.control, ref, slug, input.access);
    if (!authorized) continue;

    const href = buildHref(ai.type, ref, ai.params);

    out.push({
      actionId: randomUUID(),
      type: ai.type,
      // Article précis : « Lire l'article » plutôt qu'un renvoi générique.
      label: ai.type === 'OPEN_HELP' && href && href !== ROUTES.AIDE ? 'Lire l’article' : LABELS[ai.type],
      href,
      token: null,
      requiresConfirmation: false, // aucune action destructrice en V1 (§22.10)
      expiresAt: ai.type === 'OPEN_SEARCH_RESULTS' ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
      analyticsCode: `verebona.action.${ai.type.toLowerCase()}`,
    });
    vues.add(cle);
    if (def.isBusinessAction) businessCount++;
  }

  return out;
}

async function checkAccess(
  accountId: number,
  control: ReturnType<typeof getActionDefinition>['control'],
  ref: EntityRef | null,
  slug: string | undefined,
  access: AccessChecker,
): Promise<boolean> {
  switch (control) {
    case 'account_object': {
      if (!ref) return false;
      switch (ref.kind) {
        case 'asset': return access.assetInAccount(accountId, ref.id);
        case 'document': return access.documentInAccount(accountId, ref.id);
        case 'agenda_item': return access.agendaItemInAccount(accountId, ref.id);
        // Équipements et pièces n'ouvrent jamais directement : ils sont
        // convertis en OPEN_ASSET sur le bien parent en amont.
        default: return false;
      }
    }
    case 'published_help':
      return slug ? access.helpEntryPublished(slug) : true;
    case 'account_route':
    case 'known_offer':
    case 'signed_token':
    case 'message_owner':
    case 'recoverable_request':
    case 'supported_type':
      return true; // contrôles gérés par la route dédiée / sans cible d'objet
    default:
      return false;
  }
}
