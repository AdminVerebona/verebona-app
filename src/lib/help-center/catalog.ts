/**
 * Catalogue canonique du Centre d'aide — CDC Centre d'aide V1 §2.1, §13.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'APPLICATION NE RÉDIGE AUCUN ARTICLE
 *
 * Les articles vivent dans le dépôt du site public, seule source (§2). Le site
 * publie à chaque déploiement `/aide/catalogue.json` : ID stable → titre, URL,
 * statut. L'application ne garde que des IDs (`HELP_SHORTCUT_IDS`) et lit le
 * reste ici, à l'exécution, sur le site de SON environnement : la préproduction
 * de l'application lit le catalogue de préproduction (§2, ENV-02).
 *
 * Renommer un article ne demande donc aucune livraison de l'application ; le
 * titre affiché dans « Besoin d'aide » suit (ARCH-03, ARCH-04).
 *
 * Un ID inconnu ou non publié ne produit jamais de lien cassé : le raccourci
 * est masqué (§13, exigence bloquante), et le contrôle CI le signale
 * (`src/scripts/check-help-shortcuts.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { PUBLIC_SITE_URL } from '@/lib/external-urls';
import { parseEnvironment } from '@/services/ai/config/environment';

/**
 * Accès rapides de « Besoin d'aide », dans l'ordre d'affichage (§13).
 * Des IDs, jamais des titres ni des slugs : ajouter ou retirer un raccourci
 * est une livraison de l'application (§2.1).
 */
export const HELP_SHORTCUT_IDS = [
  'AID-ASSET-001', // Créer un bien
  'AID-DOC-001', // Ajouter un document
  'AID-TODO-001', // Comprendre « À traiter »
  'AID-AGENDA-006', // Synchroniser mon agenda
  'AID-NOTIF-003', // Gérer mes notifications
  'AID-BILL-001', // Offres et tarifs
] as const;

export const HELP_CATALOG_PATH = '/aide/catalogue.json';
export const HELP_T2_CORPUS_PATH = '/aide/corpus-t2.json';

export interface HelpCatalogEntry {
  id: string;
  title: string;
  slug: string;
  path: string;
  category: string;
  categoryName: string;
  status: 'published' | 'blocked';
  published: boolean;
  offers: string[];
}

export interface HelpCatalog {
  schema: 'verebona-help-catalog-v1';
  version: string;
  environment: string;
  articles: HelpCatalogEntry[];
  redirects: Record<string, string>;
}

export interface ResolvedShortcut {
  id: string;
  title: string;
  /** Chemin sur le site public : `/aide/<slug>`. */
  path: string;
}

/** Vérifie la forme du catalogue : un fichier inattendu vaut « pas de catalogue ». */
export function parseCatalog(json: unknown): HelpCatalog | null {
  const c = json as Partial<HelpCatalog> | null;
  if (!c || c.schema !== 'verebona-help-catalog-v1' || !Array.isArray(c.articles)) return null;
  const ok = c.articles.every((a) =>
    a && typeof a.id === 'string' && typeof a.title === 'string'
    && typeof a.path === 'string' && /^\/aide\/[a-z0-9-]+$/.test(a.path)
    && typeof a.published === 'boolean');
  return ok ? (c as HelpCatalog) : null;
}

/**
 * Raccourcis affichables : ID connu ET publié dans l'environnement.
 *
 * L'ordre est celui des IDs demandés, jamais celui du catalogue. Un ID absent
 * ou non publié est écarté — aucun libellé de secours, aucune correspondance
 * approximative (§7 : « sans 404 ni correspondance approximative »).
 */
export function resolveShortcuts(
  catalog: HelpCatalog | null,
  ids: readonly string[] = HELP_SHORTCUT_IDS,
): ResolvedShortcut[] {
  if (!catalog) return [];
  const byId = new Map(catalog.articles.map((a) => [a.id, a]));
  return ids.flatMap((id) => {
    const a = byId.get(id);
    return a && a.published ? [{ id: a.id, title: a.title, path: a.path }] : [];
  });
}

/**
 * Accès rapides selon la page — lot 35 (L35-1).
 *
 * Les mêmes six IDs (`HELP_SHORTCUT_IDS`, contrôlés par la CI), mais
 * l'article de la page ouverte passe en tête : sur l'agenda, « Synchroniser
 * mon agenda » ; sur les notifications, « Gérer mes notifications »… Aucun ID
 * nouveau, aucun titre : seul l'ordre dépend de la page. Ordinateur et
 * mobile appellent la même fonction (via `/api/help/shortcuts`).
 */
const ROUTE_SHORTCUTS: ReadonlyArray<{ pattern: RegExp; ids: readonly (typeof HELP_SHORTCUT_IDS)[number][] }> = [
  { pattern: /^\/accueil\/a-traiter(\/|$)/, ids: ['AID-TODO-001'] },
  { pattern: /^\/assets(\/|$)/, ids: ['AID-ASSET-001', 'AID-DOC-001'] },
  { pattern: /^\/documents(\/|$)/, ids: ['AID-DOC-001'] },
  { pattern: /^\/agenda(\/|$)/, ids: ['AID-AGENDA-006'] },
  { pattern: /^\/(mon-compte\/)?notifications(\/|$)/, ids: ['AID-NOTIF-003'] },
  { pattern: /^\/(abonnement|mon-compte\/offres)(\/|$)/, ids: ['AID-BILL-001'] },
];

export function shortcutIdsForRoute(route: string | null | undefined): string[] {
  const r = (route ?? '').split(/[?#]/)[0];
  const first = ROUTE_SHORTCUTS.find((s) => s.pattern.test(r))?.ids ?? [];
  return [...first, ...HELP_SHORTCUT_IDS.filter((id) => !(first as readonly string[]).includes(id))];
}

/** Écarts entre les IDs de l'application et le catalogue — pour la CI. */
export function unresolvedShortcuts(
  catalog: HelpCatalog,
  ids: readonly string[] = HELP_SHORTCUT_IDS,
): Array<{ id: string; reason: 'inconnu' | 'non publié' }> {
  const byId = new Map(catalog.articles.map((a) => [a.id, a]));
  return ids.flatMap((id): Array<{ id: string; reason: 'inconnu' | 'non publié' }> => {
    const a = byId.get(id);
    if (!a) return [{ id, reason: 'inconnu' }];
    if (!a.published) return [{ id, reason: 'non publié' }];
    return [];
  });
}

// ── Lecture (navigateur et serveur) ─────────────────────────────────────────

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
let cache: { at: number; value: HelpCatalog | null } | null = null;
let pending: Promise<HelpCatalog | null> | null = null;

/**
 * Le catalogue décrit-il l'environnement de l'application ? — CDC Centre
 * d'aide §2, ENV-02 (même règle que le corpus de l'assistant).
 *
 * En production et en préproduction, un catalogue d'un autre environnement
 * est refusé : ses statuts de publication ne sont pas ceux de l'application
 * (un article bloqué en production est publié en préproduction). En local,
 * ou sans `NEXT_PUBLIC_APP_ENV`, aucun contrôle.
 */
export function catalogMatchesEnvironment(catalogEnv: string | undefined, appEnvRaw: string | undefined): boolean {
  const app = parseEnvironment(appEnvRaw);
  if (app !== 'production' && app !== 'preprod') return true;
  return parseEnvironment(catalogEnv) === app;
}

/** URL du catalogue sur le site public de l'environnement. */
export function helpCatalogUrl(base: string = PUBLIC_SITE_URL): string {
  return `${base.replace(/\/+$/, '')}${HELP_CATALOG_PATH}`;
}

/**
 * Catalogue de l'environnement, mis en cache 5 minutes.
 *
 * Ne lève jamais : un site public indisponible donne `null`, et « Besoin
 * d'aide » affiche alors seulement l'ouverture du Centre d'aide, sans
 * raccourci plutôt qu'avec des liens incertains.
 */
export async function fetchHelpCatalog(): Promise<HelpCatalog | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  pending ??= (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(helpCatalogUrl(), { signal: ctrl.signal, credentials: 'omit' })
        .finally(() => clearTimeout(timer));
      let value = res.ok ? parseCatalog(await res.json()) : null;
      if (value && !catalogMatchesEnvironment(value.environment, process.env.NEXT_PUBLIC_APP_ENV)) {
        console.error(`[aide] Catalogue refusé : environnement « ${value.environment} » ≠ application « ${process.env.NEXT_PUBLIC_APP_ENV} » (ENV-02).`);
        value = null;
      }
      cache = { at: Date.now(), value };
      return value;
    } catch {
      // Échec non mis en cache longtemps : nouvel essai à la prochaine ouverture.
      cache = { at: Date.now() - TTL_MS + 30_000, value: null };
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Réservé aux tests. */
export function resetHelpCatalogCache(): void {
  cache = null;
  pending = null;
}

/**
 * Accès rapides pour la page ouverte, côté navigateur — lot 35 (L35-1).
 *
 * D'abord la route de l'application (`/api/help/shortcuts`, même origine :
 * ni CORS ni dépendance à l'origine de la vue web mobile) ; si elle ne répond
 * pas, l'ancienne lecture directe du catalogue (double lecture, aucune
 * régression là où elle fonctionnait). Ne lève jamais : `[]` au pire.
 */
export async function loadHelpShortcuts(
  route: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedShortcut[]> {
  try {
    const res = await fetchImpl(`/api/help/shortcuts?route=${encodeURIComponent(route ?? '')}`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json() as { available?: boolean; shortcuts?: ResolvedShortcut[] };
      if (data.available && Array.isArray(data.shortcuts)) return data.shortcuts;
    }
  } catch { /* lecture directe ci-dessous */ }
  return resolveShortcuts(await fetchHelpCatalog(), shortcutIdsForRoute(route));
}
