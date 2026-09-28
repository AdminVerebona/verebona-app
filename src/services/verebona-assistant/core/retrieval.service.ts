/**
 * Pipeline de retrieval-first — CDC §13.
 *
 * Ordre (§13.1) : sécurité/périmètre → résolution d'entités → recherche structurée →
 * plein texte → sémantique (option, désactivée) → classement → dédup → limites de
 * contexte → seuil d'insuffisance. Le périmètre compte est appliqué à CHAQUE requête
 * (§13.2) : aucune donnée hors `account_id`.
 *
 * ⚠️ JAMAIS de sérialisation de l'ensemble du compte (anti-pattern §26.2). Ce service
 *    REMPLACE `src/lib/gemini-search.ts` + la partie « chargement de contexte » de
 *    `src/lib/intelligent-search.ts`.
 */
import { pgClient, ensureUnaccent } from '@/db';
import type { IntentRoute } from '../types/contracts';
import type { AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';
import { getEnabledAdapters } from '../registries/retrieval-adapter-registry';
import { resolveEntities } from './entity-resolution.service';
import { isInventoryQuery, tokenizeQuery, type QueryTerm } from './query-terms';
import { analyserPeriode, aujourdhuiParis, sansExpressionDePeriode } from './query-period';
import { dedupeLogique } from './source-dedupe';
import type { ConversationRefs } from '../types/machine';
import { helpContextFromPage, isHelpIntent, retrieveHelpSources } from './help-corpus.service';

export async function retrieve(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]> {
  const cfg = getAssistantConfig();
  await ensureUnaccent();

  // ══════════════════════════════════════════════════════════════════════
  // 0. QUESTION D'UTILISATION — CDC Centre d'aide V1 §5
  //
  // « Pour l'aide à l'utilisation, seules les sources du Centre d'aide sont
  // autorisées. » Aucun adaptateur du compte n'est interrogé : expliquer une
  // fonction ne demande ni les documents ni les données de l'utilisateur
  // (T2-06). Seule l'offre est transmise, pour signaler une fonction non
  // incluse (T2-07).
  // ══════════════════════════════════════════════════════════════════════
  if (isHelpIntent(route.intent)) {
    // T2-05 : écran, type d'objet et plateforme pondèrent le choix des
    // articles (un article « mobile » n'est pas proposé sur le web).
    // Rôles (titulaire, membre Duo, payeur…) résolus CÔTÉ SERVEUR, jamais
    // lus du client, dans le vocabulaire des articles (`roles:`).
    const roles = await helpRolesFor(input.accountId, input.userId).catch(() => []);
    return retrieveHelpSources(input.message, input.planType, cfg.maxSources, helpContextFromPage(input.pageContext, roles));
  }

  // 1. Sécurité & périmètre (§13.2) — accountId vient du serveur, jamais du client.
  const accountId = input.accountId;

  // ══════════════════════════════════════════════════════════════════════
  // 2. RÉSOLUTION D'ENTITÉS — §13.3
  //
  // `resolveEntities` existait, testée, et n'était appelée par personne. Ses
  // résultats ne parvenaient donc jamais aux adaptateurs, qui recevaient un
  // `entityFilters` toujours vide.
  //
  // Conséquence : « et son DPE ? » après une réponse sur un bien cherchait
  // dans TOUT le compte au lieu de ce bien. L'assistant comprenait la
  // référence et l'oubliait aussitôt.
  //
  // Le contexte de page compte autant : sur la fiche d'un bien, « mes
  // factures » désigne les siennes.
  // ══════════════════════════════════════════════════════════════════════
  const refs: ConversationRefs = {
    lastPresentedEntities: [],
    // `PageContext.assetId` est une chaîne côté client ; la référence
    // conversationnelle attend un entier.
    currentAssetId: Number(input.pageContext?.assetId) || null,
  };
  const entites = resolveEntities(input.message, refs, input.pageContext);

  // Une référence ambiguë ne filtre rien : mieux vaut chercher large que
  // chercher à côté. La clarification du §20 prend alors le relais.
  const entityFilters: Record<string, string | number | null> = {};
  if (!entites.ambiguous) {
    for (const e of entites.resolved) {
      // Première référence de chaque type seulement : deux biens désignés
      // simultanément produiraient un filtre qui n'en retiendrait aucun.
      const cle = `${e.type}Id`;
      if (entityFilters[cle] === undefined) entityFilters[cle] = e.id;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2 bis. QUESTION D'INVENTAIRE — §13.4
  //
  // « j'ai quoi comme biens ? » ne nomme aucune entité. Les adaptateurs
  // cherchant par correspondance de mots, ils passaient la phrase entière dans
  // un `ILIKE` et ne ramenaient rien : l'assistant répondait « je n'ai pas
  // assez d'éléments » à la question la plus naturelle qu'on puisse lui poser.
  //
  // Le cas se tranche sans modèle : une question qui ne laisse aucun terme
  // discriminant mais porte sur une catégorie d'objets demande la LISTE. On la
  // sert par une requête bornée au compte, plutôt que de chercher une
  // correspondance qui n'existe pas.
  //
  // Placé avant les adaptateurs, et exclusif : les interroger en plus ne
  // pourrait que rapporter du bruit sur des mots outils.
  // ══════════════════════════════════════════════════════════════════════
  if (isInventoryQuery(input.message)) {
    return (await listAccountAssets(accountId, cfg.maxSources)).map((s) => ({
      ...s,
      content: s.content.slice(0, cfg.maxExcerptChars),
    }));
  }

  // 3–5. Adapters (structuré, plein texte, [sémantique sous flag]).
  //
  // La question est DÉCOUPÉE en termes (§11.2, §13.5) — racines, synonymes,
  // fautes simples, accents — au lieu d'être passée entière dans un LIKE.
  //
  // §13.7 : la période demandée (« en 2024 », « le mois dernier ») est lue à
  // part et pondère le score ; elle n'est plus cherchée comme un mot dans le
  // texte des documents. Le type de document demandé (« facture », « devis »)
  // reste un terme ET donne un bonus quand le type du document correspond.
  const { terms, period, documentTypes } = analyserRequete(input.message);
  const adapters = getEnabledAdapters();
  const collected: RetrievedSource[] = [];
  // Adaptateurs en parallèle : le retrieval déterministe tient dans ses 3 s
  // (§30.1). Un adaptateur en échec n'empêche pas les autres de répondre.
  const parts = await Promise.all(adapters.map((a) => a.search({
    accountId,
    normalizedQuery: terms.map((t) => t.stem).join(' '),
    terms,
    intent: route.intent,
    entityFilters,
    limit: cfg.maxCandidates,
    period,
    documentTypes,
  }).catch((e) => {
    if ((e as Error)?.name === 'AccountScopeViolation') throw e;
    console.warn('[verebona] adaptateur de recherche en échec :', (e as Error).message);
    return [] as RetrievedSource[];
  })));
  for (const part of parts) collected.push(...part);

  // Repli si aucun adapter enregistré : recherche structurée minimale sur les biens.
  if (adapters.length === 0) {
    collected.push(...(await structuredAssetSearch(accountId, input.message, cfg.maxCandidates)));
  }

  // 6–7. Classement + déduplication (§13.7-13.8). Tri AVANT le
  // dédoublonnage logique : parmi des doublons, la source la mieux classée
  // (puis la plus récente) est gardée.
  const deduped = dedupeLogique([...collected].sort((x, y) => (y.relevanceScore ?? 0) - (x.relevanceScore ?? 0)));

  // 8. Limites (§13.9) : 20 candidats au plus avant le classement final,
  // extraits bornés. L'orchestrateur n'en garde que `maxSources` pour les
  // sources et le modèle ; les autres servent aux cartes de résultats
  // groupées et au « Voir tous les résultats » (§11.3).
  return deduped.slice(0, Math.max(cfg.maxSources, cfg.maxCandidates)).map((s) => ({
    ...s,
    content: s.content.slice(0, cfg.maxExcerptChars),
  }));
}

/**
 * Rôles des articles d'aide — référentiel fermé du site public
 * (`src/help/referentials.ts` `ROLES`). `all` n'est jamais attribué : c'est
 * une valeur d'article (« pour tous »), pas une situation d'utilisateur.
 */
export type HelpArticleRole =
  | 'owner' | 'duo_member' | 'authorized_user' | 'recipient'
  | 'concerned_user' | 'billing_owner' | 'referrer';

/** Situation réelle de l'utilisateur, lue en base (`helpRolesFor`). */
export interface HelpRoleSituation {
  /** Titulaire du compte courant (`accounts.owner_user_id`). */
  accountOwner: boolean;
  /** Utilisateur autorisé : membre actif du compte courant sans en être titulaire. */
  accountMember: boolean;
  /** Titulaire payeur d'un Premium Duo (`duo_accounts.billing_owner_user_id`). */
  duoHolder: boolean;
  /** Second utilisateur actif d'un Duo dont il n'est pas le payeur. */
  duoMember: boolean;
  /** Titulaire d'un compte rattaché à un client Stripe (abonnement payé par lui). */
  paysSubscription: boolean;
  /** Destinataire d'une transmission de bien en attente. */
  pendingTransmission: boolean;
}

/**
 * Situation → rôles des articles — CDC Centre d'aide T2-05.
 *
 *   · titulaire du compte      → owner, referrer (tout titulaire peut
 *                                parrainer, AID-BILL-010), concerned_user ;
 *   · titulaire qui paie / titulaire d'un Duo → + billing_owner ;
 *   · membre Duo (non payeur)  → duo_member, concerned_user ;
 *   · membre du compte         → authorized_user, concerned_user ;
 *   · transmission en attente  → + recipient.
 *
 * `concerned_user` (AID-ACCOUNT-006, suppression de SON compte) vaut pour
 * tout utilisateur identifié. Un membre Duo n'est jamais `billing_owner` :
 * seul le titulaire paie et peut se rétracter (AID-BILL-009).
 */
export function helpRolesFromSituation(s: HelpRoleSituation): HelpArticleRole[] {
  const roles = new Set<HelpArticleRole>(['concerned_user']);
  if (s.accountOwner || s.duoHolder) roles.add('owner');
  if (s.accountOwner) roles.add('referrer');
  if (s.duoHolder || (s.accountOwner && s.paysSubscription)) roles.add('billing_owner');
  if (s.duoMember && !s.duoHolder) roles.add('duo_member');
  if (s.accountMember && !s.accountOwner && !s.duoMember) roles.add('authorized_user');
  if (s.pendingTransmission) roles.add('recipient');
  return [...roles];
}

/**
 * Rôles de l'utilisateur, au format des articles d'aide — CDC Centre d'aide
 * T2-05. Une seule requête, bornée au compte courant et à l'utilisateur de
 * la session ; renvoie `[]` si le compte est introuvable.
 */
export async function helpRolesFor(accountId: number, userId: number): Promise<HelpArticleRole[]> {
  const rows = (await pgClient.unsafe(
    `SELECT
        (a.owner_user_id = $2) AS account_owner,
        EXISTS (SELECT 1 FROM account_memberships m
                 WHERE m.account_id = a.id AND m.user_id = $2
                   AND lower(m.status) = 'active' AND m.role <> 'owner') AS account_member,
        EXISTS (SELECT 1 FROM duo_accounts d
                 WHERE d.billing_owner_user_id = $2
                   AND d.subscription_status NOT IN ('CANCELED', 'EXPIRED')) AS duo_holder,
        EXISTS (SELECT 1 FROM duo_memberships dm
                  JOIN duo_accounts d ON d.id = dm.duo_id
                 WHERE dm.user_id = $2 AND dm.status = 'ACTIVE'
                   AND d.billing_owner_user_id <> $2) AS duo_member,
        (a.stripe_customer_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM account_subscriptions s
                      WHERE s.account_id = a.id AND s.stripe_customer_id IS NOT NULL)) AS pays_subscription,
        EXISTS (SELECT 1 FROM asset_transmissions t
                 WHERE t.status = 'pending'
                   AND (t.recipient_user_id = $2
                        OR lower(t.recipient_email) = (SELECT lower(u.email) FROM users u WHERE u.id = $2))) AS pending_transmission
       FROM accounts a WHERE a.id = $1 LIMIT 1`,
    [accountId, userId],
  )) as unknown as Array<Record<string, boolean | null>>;
  const r = rows[0];
  if (!r) return [];
  return helpRolesFromSituation({
    accountOwner: !!r.account_owner,
    accountMember: !!r.account_member,
    duoHolder: !!r.duo_holder,
    duoMember: !!r.duo_member,
    paysSubscription: !!r.pays_subscription,
    pendingTransmission: !!r.pending_transmission,
  });
}

/**
 * Liste les biens du compte, sans critère — réponse à une question d'inventaire.
 *
 * Bornée par `maxSources` comme toute réponse : le §26.2 interdit de sérialiser
 * l'ensemble du compte, et un utilisateur qui possède cinquante biens n'attend
 * pas cinquante lignes mais un aperçu et un lien vers la liste complète.
 */
async function listAccountAssets(accountId: number, limit: number): Promise<RetrievedSource[]> {
  const rows = await pgClient.unsafe(
    `SELECT id, name, category, city
       FROM assets
      WHERE account_id = $1 AND deleted_at IS NULL
      ORDER BY name
      LIMIT $2`,
    [accountId, limit],
  );
  return (rows as unknown as Array<{ id: number; name: string; category: string | null; city: string | null }>)
    .map((r) => ({
      id: `asset_${r.id}`,
      type: 'asset_field' as const,
      title: r.name,
      content: [r.category, r.city].filter(Boolean).join(' · '),
      meta: { assetId: r.id },
      // Tous à égalité : aucune pertinence à départager, l'ordre est alphabétique.
      relevanceScore: 0.6,
    }));
}

/** Recherche structurée de base sur les biens du compte (niveau 1 — §13.4). */
async function structuredAssetSearch(accountId: number, query: string, limit: number): Promise<RetrievedSource[]> {
  // Paramétré, borné au compte. unaccent pour tolérance accents (§13.5).
  // Décision V1 : recherche lexicale (T2-008), servie par l'index
  // trigrammes de la migration 0208 — même expression que l'index.
  const { searchExprMode, normalizedText } = await import('./search-sql');
  const mode = await searchExprMode();
  const rows = await pgClient.unsafe(
    `SELECT id, name, category, city
       FROM assets
      WHERE account_id = $1 AND deleted_at IS NULL
        AND ${normalizedText(mode, 'name')} LIKE ${normalizedText(mode, '$2')}
      ORDER BY name
      LIMIT $3`,
    [accountId, `%${query}%`, limit],
  );
  return (rows as unknown as Array<{ id: number; name: string; category: string | null; city: string | null }>).map((r) => ({
    id: `asset_${r.id}`,
    type: 'asset_field' as const,
    title: r.name,
    content: [r.category, r.city].filter(Boolean).join(' · '),
    meta: { assetId: r.id },
    relevanceScore: 0.5,
  }));
}

/** Racines de types de document reconnues dans une question (§13.7). */
const TYPES_DOCUMENT = new Set([
  'facture', 'devis', 'contrat', 'garantie', 'dpe', 'notice', 'manuel', 'certificat', 'attestation',
  'assurance', 'acte', 'bail', 'quittance', 'releve', 'diagnostic', 'rapport', 'ticket', 'constat', 'avenant',
]);

/**
 * Découpe une question en termes, période demandée et types de document
 * demandés (§13.7). Exporté pour les tests.
 */
export function analyserRequete(message: string, today: string = aujourdhuiParis()): {
  terms: QueryTerm[];
  period: { from: string; to: string } | null;
  documentTypes: string[];
} {
  const p = analyserPeriode(message, today);
  const periode = p?.kind === 'resolved' ? p : null;
  const terms = tokenizeQuery(periode ? sansExpressionDePeriode(message, periode) : message);
  const documentTypes = [...new Set(terms.filter((t) => !t.exact && TYPES_DOCUMENT.has(t.stem)).map((t) => t.stem))];
  return { terms, period: periode ? { from: periode.from, to: periode.to } : null, documentTypes };
}

/**
 * Résultats proches — CDC §11.4.
 *
 * Seconde passe, lancée seulement quand la recherche normale n'a rien
 * trouvé : mêmes adaptateurs, même périmètre (§13.2), motifs élargis et
 * correspondance approximative (deux fautes au plus). Au plus 3 résultats,
 * au score plafonné : ils sont présentés comme « proches », jamais comme la
 * réponse.
 */
export async function retrieveNear(route: IntentRoute, input: AssistantRequestInput, max = 3): Promise<RetrievedSource[]> {
  if (isHelpIntent(route.intent)) return [];
  const { terms, period, documentTypes } = analyserRequete(input.message);
  if (terms.filter((t) => !t.exact).length === 0) return [];
  const parts = await Promise.all(getEnabledAdapters().map((a) => a.search({
    accountId: input.accountId,
    normalizedQuery: terms.map((t) => t.stem).join(' '),
    terms,
    intent: route.intent,
    entityFilters: {},
    limit: 10,
    period,
    documentTypes,
    tolerant: true,
  }).catch((e) => {
    if ((e as Error)?.name === 'AccountScopeViolation') throw e;
    return [] as RetrievedSource[];
  })));
  return dedupeLogique(parts.flat().sort((x, y) => (y.relevanceScore ?? 0) - (x.relevanceScore ?? 0))).slice(0, max);
}
