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
 * (`scripts/check-help-shortcuts.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { PUBLIC_SITE_URL } from '@/lib/external-urls';

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
      const value = res.ok ? parseCatalog(await res.json()) : null;
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
