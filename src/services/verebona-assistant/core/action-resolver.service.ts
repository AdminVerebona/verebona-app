/**
 * Résolveur d'actions — CDC §22.6 / §22.7.
 *
 * À partir d'`ActionIntent` (type + id fourni), le SERVEUR :
 *  - vérifie que le type est autorisé pour l'intention ;
 *  - applique le contrôle d'accès (objet du compte, route, jeton, aide publiée…) ;
 *  - génère actionId, label lisible, href interne, expiration et code analytics.
 *
 * Le href N'EST JAMAIS fourni par le modèle (§22.1). Les URLs sont construites ici à
 * partir des routes réelles de l'app.
 */
import { randomUUID } from 'crypto';
import type { ActionIntent, VerebonaAction, VerebonaActionType } from '../types/actions';
import type { VerebonaIntent } from '../types/intents';
import { getActionDefinition, allowedActionsFor } from '../registries/action-registry';

/** Vérifie qu'un objet appartient bien au compte (à implémenter avec le repo). */
export interface AccessChecker {
  assetInAccount(accountId: number, assetId: string): Promise<boolean>;
  documentInAccount(accountId: number, documentId: string): Promise<boolean>;
  agendaItemInAccount(accountId: number, agendaItemId: string): Promise<boolean>;
  supplierInAccount(accountId: number, supplierId: string): Promise<boolean>;
  helpEntryPublished(slug: string): Promise<boolean>;
}

/** Construit les href internes à partir des routes réelles (§22.7). */
function buildHref(type: VerebonaActionType, id?: string | number | null, params?: Record<string, unknown>): string | null {
  switch (type) {
    case 'OPEN_ASSET': return id != null ? `/assets/${id}` : null;
    case 'OPEN_DOCUMENT': return id != null ? `/documents/${id}` : null;
    case 'OPEN_DOCUMENTS_PAGE': return '/documents';
    case 'OPEN_AGENDA': return '/agenda';
    case 'OPEN_AGENDA_ITEM': return id != null ? `/agenda/${id}` : null;
    case 'OPEN_TO_PROCESS': return '/a-traiter';
    case 'OPEN_SUPPLIERS': return '/fournisseurs';
    case 'OPEN_SUPPLIER': return id != null ? `/fournisseurs/${id}` : null;
    case 'OPEN_ACCOUNT': return '/compte';
    case 'OPEN_PRICING': return '/abonnement';
    case 'OPEN_HELP': return id != null ? `/aide/${id}` : '/aide';
    case 'START_ADD_ASSET': return '/assets/nouveau';
    case 'START_ADD_DOCUMENT': return id != null ? `/assets/${id}?ajouter=document` : '/documents?ajouter=1';
    case 'START_ADD_AGENDA_ITEM': return id != null ? `/agenda/nouveau?asset=${id}` : '/agenda/nouveau';
    case 'OPEN_EXPORT_AREA': return id != null ? `/assets/${id}?onglet=export` : '/export';
    case 'OPEN_SEARCH_RESULTS': return null; // via jeton signé (résolu par la route dédiée)
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
  OPEN_AGENDA: "Ouvrir l'agenda", OPEN_AGENDA_ITEM: "Voir l'échéance",
  OPEN_TO_PROCESS: 'Voir « À traiter »', OPEN_SUPPLIERS: 'Voir les fournisseurs',
  OPEN_SUPPLIER: 'Ouvrir le fournisseur', OPEN_ACCOUNT: 'Ouvrir mon compte',
  OPEN_PRICING: 'Voir les offres', OPEN_HELP: "Consulter l'aide",
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

/** Résout et filtre les actions proposées par le modèle (§22.6-22.7). */
export async function resolveActions(input: ResolveActionsInput): Promise<VerebonaAction[]> {
  const allowed = new Set(allowedActionsFor(input.intent));
  const out: VerebonaAction[] = [];
  let businessCount = 0;

  for (const ai of input.actionIntents) {
    if (!allowed.has(ai.type)) continue;
    const def = getActionDefinition(ai.type);

    // Limite 1 principale + 2 secondaires : ici on borne les actions métier (§22.9).
    if (def.isBusinessAction && businessCount >= 3) continue;

    // Contrôle d'accès (§22.7).
    const id = ai.targetId != null ? String(ai.targetId) : undefined;
    const authorized = await checkAccess(input.accountId, def.control, id, input.access);
    if (!authorized) continue;

    const href = buildHref(ai.type, ai.targetId ?? null, ai.params);
    out.push({
      actionId: randomUUID(),
      type: ai.type,
      label: LABELS[ai.type],
      href,
      token: null,
      requiresConfirmation: false, // aucune action destructrice en V1 (§22.10)
      expiresAt: ai.type === 'OPEN_SEARCH_RESULTS' ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
      analyticsCode: `verebona.action.${ai.type.toLowerCase()}`,
    });
    if (def.isBusinessAction) businessCount++;
  }

  return out;
}

async function checkAccess(
  accountId: number,
  control: ReturnType<typeof getActionDefinition>['control'],
  id: string | undefined,
  access: AccessChecker,
): Promise<boolean> {
  switch (control) {
    case 'account_object':
      if (!id) return false;
      // On ne connaît pas le type exact ici : l'appelant a filtré par intention,
      // mais par sécurité on tente les vérificateurs plausibles.
      return (
        (await access.assetInAccount(accountId, id)) ||
        (await access.documentInAccount(accountId, id)) ||
        (await access.agendaItemInAccount(accountId, id)) ||
        (await access.supplierInAccount(accountId, id))
      );
    case 'published_help':
      return id ? access.helpEntryPublished(id) : true;
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
