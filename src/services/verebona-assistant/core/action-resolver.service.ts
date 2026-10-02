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
import { createSearchToken } from './search-token';
import { DOSSIER_CODES, normalizeExportCode } from '@/services/exports/catalog';
import type { ActionIntent, VerebonaAction, VerebonaActionType } from '../types/actions';
import type { VerebonaIntent } from '../types/intents';
import { getActionDefinition, allowedActionsFor } from '../registries/action-registry';
import { HELP_CONTACT_PATH, integratedHelpHref, isHelpPath } from '@/lib/help-center/open';
import {
  parseEntityRef, hrefBien, ROUTES,
  type EntityKind, type EntityRef, type OngletBien,
} from './entity-ref';
import { supplierHref } from '@/lib/supplier-routes';
import { isPlanAiEligible } from '../registries/capability-registry';

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
  /**
   * Fournisseur du compte (non supprimé). Facultatif : un vérificateur qui ne
   * le fournit pas refuse toute ouverture de fiche fournisseur.
   */
  supplierInAccount?(accountId: number, supplierId: number): Promise<boolean>;
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
  OPEN_SUPPLIER: 'supplier',
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
    // Fiche fournisseur (`/fournisseurs/[id]`) et liste (`/fournisseurs`).
    case 'OPEN_SUPPLIER':
      return ref ? supplierHref(ref.id) : null;
    case 'OPEN_SUPPLIERS':
      return ROUTES.FOURNISSEURS;
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
  /**
   * Offre effective de l'assistant (`assistantPlanFromEntitlements`) et
   * limite de compte (lecture seule) — §22.7 étape 3 « vérifie l'offre ».
   * Absentes : aucune restriction d'offre (appelants historiques, tests).
   */
  planType?: string;
  planLimit?: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | null;
}

// ══════════════════════════════════════════════════════════════════════════
// CONTRÔLE DE L'OFFRE — §22.7 étape 3
//
// `known_offer` et `supported_type` renvoyaient toujours vrai, et aucune
// action n'était confrontée à l'offre : un compte Standard se voyait
// proposer un dossier prêt à l'usage (Premium), un compte en lecture seule
// un bouton « Ajouter un document » qui échouait au clic.
// Les règles reprennent celles des routes de l'application (exports :
// `app/api/assets/[id]/exports`, droits : `entitlements.service`).
// ══════════════════════════════════════════════════════════════════════════

/** Offres connues de la page des offres (paramètre `offer` d'OPEN_PRICING). */
export const OFFRES_CONNUES: ReadonlySet<string> = new Set(['STANDARD', 'PREMIUM', 'PREMIUM_DUO']);

/** Familles de biens créables (paramètre `assetType` de START_ADD_ASSET). */
export const TYPES_BIEN_SUPPORTES: ReadonlySet<string> = new Set(['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT']);

/** Dossiers prêts à l'usage : Premium et Premium Duo seulement (EXPORT_BRUT exclu). */
/** Codes V12 (`services/exports/catalog`) ; un ancien code est ramené au code V12 avant contrôle. */
export const EXPORTS_PREMIUM: ReadonlySet<string> = new Set<string>(DOSSIER_CODES);

/** Le code d'export (V12 ou ancien) désigne-t-il un dossier Premium ? */
export function isPremiumExportCode(code: unknown): boolean {
  const c = normalizeExportCode(code);
  return c !== null && EXPORTS_PREMIUM.has(c);
}

/** Actions qui mènent à une création : impossibles sur un compte en lecture seule. */
const ACTIONS_ECRITURE: ReadonlySet<VerebonaActionType> = new Set<VerebonaActionType>([
  'START_ADD_ASSET', 'START_ADD_DOCUMENT', 'START_ADD_AGENDA_ITEM',
]);

/** L'offre du compte permet-elle cette action ? (§22.7 étape 3) */
export function offrePermet(
  type: VerebonaActionType,
  params: Record<string, unknown> | undefined,
  planType: string | undefined,
  planLimit: ResolveActionsInput['planLimit'],
): boolean {
  // Compte en lecture seule (essai échu, abonnement requis) : ni création,
  // ni dossier Premium — la consultation et l'export brut restent ouverts.
  if (planLimit && ACTIONS_ECRITURE.has(type)) return false;
  if (type === 'OPEN_EXPORT_AREA' && isPremiumExportCode(params?.exportType)) {
    if (planLimit) return false;
    if (planType !== undefined && !isPlanAiEligible(planType)) return false;
  }
  return true;
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

    // Offre (§22.7 étape 3), avant tout accès en base.
    if (!offrePermet(ai.type, ai.params, input.planType, input.planLimit)) continue;

    const slug = ai.targetId != null ? String(ai.targetId) : undefined;
    const authorized = sansCible || await checkAccess(input.accountId, def.control, ref, slug, input.access, ai.params);
    if (!authorized) continue;

    let href = buildHref(ai.type, ref, ai.params);
    let token: string | null = null;
    // §22.4 (D-J3) : résultats préparés par le serveur, scellés dans un jeton
    // signé, court (30 min) et lié au compte — résolu par
    // `GET /api/verebona/search-results`, qui revérifie chaque objet.
    if (ai.type === 'OPEN_SEARCH_RESULTS') {
      token = searchResultsToken(input.accountId, ai.params);
      if (!token) continue;
      href = `/api/verebona/search-results?t=${token}`;
    }

    out.push({
      actionId: randomUUID(),
      type: ai.type,
      // Article précis : « Lire l'article » plutôt qu'un renvoi générique.
      // « Lire l'article » pour un article précis ; « Ouvrir l'aide » pour
      // l'accueil ou la recherche du Centre d'aide (§10.6, D-J4).
      label: ai.type === 'OPEN_HELP'
        ? (ai.params?.search === true || !href || href === ROUTES.AIDE ? 'Ouvrir l’aide' : 'Lire l’article')
        : LABELS[ai.type],
      href,
      token,
      requiresConfirmation: false, // aucune action destructrice en V1 (§22.10)
      expiresAt: ai.type === 'OPEN_SEARCH_RESULTS' ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
      analyticsCode: `verebona.action.${ai.type.toLowerCase()}`,
      // §28.6 : cible contrôlée et paramètres validés, persistés avec l'action
      // (jamais renvoyés au client : `toApiPayload` les retire).
      targetRef: ref ? `${ref.kind}:${ref.id}` : null,
      payload: ai.params ? { ...ai.params } : {},
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
  params?: Record<string, unknown>,
): Promise<boolean> {
  switch (control) {
    case 'account_object': {
      if (!ref) return false;
      switch (ref.kind) {
        case 'asset': return access.assetInAccount(accountId, ref.id);
        case 'document': return access.documentInAccount(accountId, ref.id);
        case 'agenda_item': return access.agendaItemInAccount(accountId, ref.id);
        case 'supplier': return access.supplierInAccount ? access.supplierInAccount(accountId, ref.id) : false;
        // Équipements et pièces n'ouvrent jamais directement : ils sont
        // convertis en OPEN_ASSET sur le bien parent en amont.
        default: return false;
      }
    }
    case 'published_help':
      return slug ? access.helpEntryPublished(slug) : true;
    // Offre nommée : seulement une offre réellement proposée.
    case 'known_offer':
      return params?.offer == null || (typeof params.offer === 'string' && OFFRES_CONNUES.has(params.offer));
    // Type de bien : seulement une famille que l'application sait créer.
    case 'supported_type':
      return params?.assetType == null
        || (typeof params.assetType === 'string' && TYPES_BIEN_SUPPORTES.has(params.assetType));
    case 'account_route':
    case 'signed_token':
    case 'message_owner':
    case 'recoverable_request':
      return true; // contrôles gérés par la route dédiée / sans cible d'objet
    default:
      return false;
  }
}

/** Jeton OPEN_SEARCH_RESULTS, ou `null` si les paramètres ne désignent rien. */
function searchResultsToken(accountId: number, params: Record<string, unknown> | undefined): string | null {
  const scope = params?.scope === 'agenda' ? 'agenda' : params?.scope === 'documents' ? 'documents' : null;
  if (!scope) return null;
  // Identifiants en liste « 12,34 » (paramètres d'action scalaires).
  const liste = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').filter(Boolean) : Array.isArray(v) ? v.map(String) : []);
  const ids = liste(params?.ids);
  const assets = liste(params?.assets);
  if (ids.length === 0 && assets.length === 0) return null;
  try {
    return createSearchToken({ accountId, scope, ids, assets });
  } catch (e) {
    console.warn('[verebona] jeton de résultats non signé :', (e as Error).message);
    return null;
  }
}

