/**
 * Pipeline de retrieval-first — CDC §13.
 *
 * Ordre (§13.1) : sécurité/périmètre → résolution d'entités → recherche structurée →
 * plein texte → sémantique (option, désactivée) → classement → dédup → limites de
 * contexte → seuil d'insuffisance. Le périmètre compte est appliqué à CHAQUE requête
 * (§13.2) : aucune donnée hors `account_id`.
 *
 * ⚠️ JAMAIS de sérialisation de l'ensemble du compte (anti-pattern §26.2). Ce service
 *    a remplacé la recherche Gemini historique (`lib/gemini-search.ts`,
 *    `lib/intelligent-search.ts`, supprimées au lot 16b-2, décision D-H2).
 *
 * Lecture CANONIQUE seule depuis le lot 16b-2 (commutateur
 * ASSISTANT_CANONICAL_READ et parcours historique retirés) : cibles résolues
 * côté serveur, contrat de sources de l'intention, filtres structurés.
 */
import { pgClient, ensureUnaccent } from '@/db';
import type { IntentRoute } from '../types/contracts';
import type { AssistantRequestInput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';
import { getEnabledAdapters } from '../registries/retrieval-adapter-registry';
import { isInventoryQuery, tokenizeQuery, type QueryTerm } from './query-terms';
import { analyserPeriode, aujourdhuiParis, sansExpressionDePeriode } from './query-period';
import { dedupeLogique } from './source-dedupe';
import { helpContextFromPage, isHelpIntent, retrieveHelpSources } from './help-corpus.service';
import { getIntentDefinition } from '../registries/intent-registry';
import type { RetrievalAdapter } from '../registries/retrieval-adapter-registry';
import type { SourceType } from '../types/sources';
import { documentSearchFilters, documentTypeStems, hasDocumentFilters, type DocumentSearchFilters } from './query-terms';
import { resolveAssistantTargets, type AssistantTargets } from './assistant-targets';
import { assistantAssetAvailability } from './asset-availability';
import type { RouteUnderstanding } from '../types/contracts';
import type { DocumentAnalysisFilter } from './query-terms';
import { resolveDocumentType } from '@/services/canonical/registry';
import { resolveDocumentCode } from '@/lib/referential/document-codes';

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

  // 1. Sécurité & périmètre (§13.2) — accountId vient du serveur, jamais du
  // client (`retrieveCanonical` le lit dans `input`). CDC 15 §9 (lot 15) :
  // lecture canonique — cibles, contrat de sources de l'intention, filtres
  // structurés.
  return retrieveCanonical(route, input);
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
    `SELECT a.id, a.name, a.category, a.city
       FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
      ORDER BY a.name
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
       FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
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

// ══════════════════════════════════════════════════════════════════════════
// LECTURE CANONIQUE — CDC 15 T2-07, T2-08, T2-13, T2-14, T2-16, T2-17,
// T2-21 (lot 15)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Adaptateurs interrogés pour une intention — T2-07 (pure, testée).
 *
 * Seuls ceux dont un type de source est attendu par l'intention
 * (`expectedSourceTypes` du registre). REPLI documenté : une intention sans
 * contrat de sources (UNKNOWN, recherche simple d'un gabarit) ou dont aucun
 * adaptateur ne couvre le contrat interroge les adaptateurs de données
 * historiques (ceux qui n'émettent ni aide ni règle d'offre).
 */
export function adaptersForIntent(
  intent: string,
  adapters: RetrievalAdapter[],
): { adapters: RetrievalAdapter[]; expected: SourceType[]; fallback: boolean } {
  const def = (() => { try { return getIntentDefinition(intent as never); } catch { return undefined; } })();
  const expected = [...(def?.expectedSourceTypes ?? [])] as SourceType[];
  const donnees = adapters.filter((a) => !(a.sourceTypes ?? []).includes('product_rule'));
  if (expected.length === 0) return { adapters: donnees, expected, fallback: true };
  const retenus = adapters.filter((a) => (a.sourceTypes ?? []).some((t) => expected.includes(t)));
  if (retenus.length === 0) return { adapters: donnees, expected, fallback: true };
  return { adapters: retenus, expected, fallback: false };
}

/** Filtres de cible pour les adaptateurs (bien, document, fournisseur). */
export function entityFiltersFromTargets(t: AssistantTargets): Record<string, string | number | null> {
  const f: Record<string, string | number | null> = {};
  // Plusieurs biens nommés (« compare la Clio et la Polo ») : aucun filtre
  // unique — chercher dans un seul mélangerait moins que choisir au hasard.
  if (t.asset && !(t.namedAssets.length > 1 && t.asset.origin !== 'clarification' && t.asset.origin !== 'thread')) f.assetId = t.asset.id;
  if (t.document) f.documentId = t.document.id;
  if (t.agendaItem) f.agendaItemId = t.agendaItem.id;
  if (t.supplier?.id) f.supplierId = t.supplier.id;
  return f;
}

/**
 * Découpe canonique (pure, testée) : filtres structurés RETIRÉS du texte,
 * types de document demandés, termes restants, période.
 */
export function analyserRequeteCanonique(message: string, today: string = aujourdhuiParis()): {
  terms: QueryTerm[];
  period: { from: string; to: string } | null;
  documentTypes: string[];
  documentFilters: DocumentSearchFilters;
} {
  const { filters, rest } = documentSearchFilters(message);
  const p = analyserPeriode(rest, today);
  const periode = p?.kind === 'resolved' ? p : null;
  const terms = tokenizeQuery(periode ? sansExpressionDePeriode(rest, periode) : rest);
  return { terms, period: periode ? { from: periode.from, to: periode.to } : null, documentTypes: documentTypeStems(terms), documentFilters: filters };
}

/** Statut d'analyse désigné par le master (texte libre ou code). */
function statutAnalyse(v: string): DocumentAnalysisFilter | null {
  const t = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/echec|echou|fail|impossible/.test(t)) return 'ANALYSIS_FAILED';
  if (/verifi|valid|conflict/.test(t)) return 'TO_VALIDATE';
  if (/non.?analys|not.?analy|sans analyse/.test(t)) return 'NOT_ANALYZED';
  if (/cours|in.?analysis|analyzing|attente|uploaded|uploading/.test(t)) return 'IN_ANALYSIS';
  if (/analys/.test(t)) return 'ANALYZED';
  return null;
}

/**
 * Filtres du master T2 (UNDERSTAND, A5) ajoutés à ceux lus dans la question
 * (pure, testée). La question prime : un filtre du modèle ne remplace
 * jamais un filtre explicite, il complète. Type : code documentaire connu
 * (registre, référentiel V2) ou mot (« facture »).
 */
export function mergeUnderstandingFilters(
  a: ReturnType<typeof analyserRequeteCanonique>,
  u: RouteUnderstanding | undefined,
): ReturnType<typeof analyserRequeteCanonique> & { documentTypeCodes: string[] } {
  const out = { ...a, documentFilters: { ...a.documentFilters }, documentTypes: [...a.documentTypes], documentTypeCodes: [] as string[] };
  const f = u?.filters;
  if (!f) return out;
  if (f.unlinked === true && !out.documentFilters.link) out.documentFilters.link = 'unlinked';
  if (f.status && !out.documentFilters.analysis?.length) {
    const st = statutAnalyse(f.status);
    if (st) out.documentFilters.analysis = [st];
  }
  if (f.supplier && !out.documentFilters.supplierName && f.supplier.trim().length >= 2) out.documentFilters.supplierName = f.supplier.trim().toLowerCase();
  if (f.documentType && out.documentTypes.length === 0) {
    const v = f.documentType.trim();
    // Lot 30 : un CODE (V2, V1, catalogue, ancien code) est reconnu par le
    // résolveur documentaire unique, comme partout ailleurs.
    const r = /^[A-Z0-9_]+$/.test(v) ? resolveDocumentCode(v) : null;
    const entree = r && r.status !== 'UNKNOWN' ? resolveDocumentType(v) : undefined;
    if (r && r.status !== 'UNKNOWN') {
      out.documentTypeCodes = [...new Set([v, ...(r.storageCode ? [r.storageCode] : []), ...(r.v2Type ? [r.v2Type] : []),
        ...(entree ? [entree.code, ...(entree.aliases ?? [])] : [])].map((c) => c.toUpperCase()))];
    } else {
      out.documentTypes = documentTypeStems(tokenizeQuery(v));
    }
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!out.period && f.periodStart && iso.test(f.periodStart)) {
    out.period = { from: f.periodStart, to: f.periodEnd && iso.test(f.periodEnd) ? f.periodEnd : '9999-12-31' };
  } else if (!out.period && f.periodEnd && iso.test(f.periodEnd)) {
    out.period = { from: '0001-01-01', to: f.periodEnd };
  }
  return out;
}

/** Retrieval canonique (voir l'en-tête de section). */
async function retrieveCanonical(route: IntentRoute, input: AssistantRequestInput): Promise<RetrievedSource[]> {
  const cfg = getAssistantConfig();
  const accountId = input.accountId;
  const cibles = await resolveAssistantTargets(input, route);
  const entityFilters = entityFiltersFromTargets(cibles);

  if (isInventoryQuery(input.message) && !hasDocumentFilters(documentSearchFilters(input.message).filters)) {
    return (await listAccountAssets(accountId, cfg.maxSources)).map((s) => ({ ...s, content: s.content.slice(0, cfg.maxExcerptChars) }));
  }

  // Filtres du master T2 (A5), en complément de ceux de la question.
  const { terms, period, documentTypes, documentFilters, documentTypeCodes } =
    mergeUnderstandingFilters(analyserRequeteCanonique(input.message), route.understanding);
  const choix = adaptersForIntent(route.intent, getEnabledAdapters());
  const base = {
    accountId,
    normalizedQuery: terms.map((t) => t.stem).join(' '),
    terms,
    intent: route.intent,
    entityFilters,
    limit: cfg.maxCandidates,
    // Période : celle de la question, sinon celle d'un indice (T2-08).
    period: period ?? cibles.hints.period,
    documentTypes,
    documentFilters,
    documentTypeFilter: documentTypes,
    documentTypeCodes,
    hints: { documentTitles: cibles.hints.documentTitles, supplierNames: cibles.hints.supplierNames },
  };
  const parts = await Promise.all(choix.adapters.map((a) => a.search(base).catch((e) => {
    if ((e as Error)?.name === 'AccountScopeViolation') throw e;
    console.warn('[verebona] adaptateur de recherche en échec :', (e as Error).message);
    return [] as RetrievedSource[];
  })));
  let collected = parts.flat();
  if (choix.adapters.length === 0) collected.push(...(await structuredAssetSearch(accountId, input.message, cfg.maxCandidates)));
  // Contrat de l'intention (T2-07) : aucune source hors des types attendus.
  if (!choix.fallback) collected = collected.filter((s) => choix.expected.includes(s.type));
  const deduped = dedupeLogique([...collected].sort((x, y) => (y.relevanceScore ?? 0) - (x.relevanceScore ?? 0)));
  return deduped.slice(0, Math.max(cfg.maxSources, cfg.maxCandidates)).map((s) => ({ ...s, content: s.content.slice(0, cfg.maxExcerptChars) }));
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
  return retrieveNearCanonical(route, input, max);
}

/**
 * Résultats proches, mode canonique : même contrat de sources (T2-07), même
 * cible et mêmes filtres structurés que la recherche normale — seule la
 * correspondance des termes est élargie.
 */
async function retrieveNearCanonical(route: IntentRoute, input: AssistantRequestInput, max: number): Promise<RetrievedSource[]> {
  const { terms, period, documentTypes, documentFilters } = analyserRequeteCanonique(input.message);
  if (terms.filter((t) => !t.exact).length === 0) return [];
  const cibles = await resolveAssistantTargets(input, route);
  const choix = adaptersForIntent(route.intent, getEnabledAdapters());
  const parts = await Promise.all(choix.adapters.map((a) => a.search({
    accountId: input.accountId,
    normalizedQuery: terms.map((t) => t.stem).join(' '),
    terms,
    intent: route.intent,
    entityFilters: entityFiltersFromTargets(cibles),
    limit: 10,
    period: period ?? cibles.hints.period,
    documentTypes,
    tolerant: true,
    documentFilters,
    documentTypeFilter: documentTypes,
  }).catch((e) => {
    if ((e as Error)?.name === 'AccountScopeViolation') throw e;
    return [] as RetrievedSource[];
  })));
  let tous = parts.flat();
  if (!choix.fallback) tous = tous.filter((s) => choix.expected.includes(s.type));
  return dedupeLogique(tous.sort((x, y) => (y.relevanceScore ?? 0) - (x.relevanceScore ?? 0))).slice(0, max);
}
