/**
 * Accès rapides de « Besoin d'aide ? », côté serveur — lot 35 (L35-1),
 * lot 62 (L62-AIDE). Serveur uniquement (lit le corpus de l'assistant,
 * dont le dernier exemplaire valide est conservé en base).
 *
 * 1. Catalogue du site public de l'environnement (`/aide/catalogue.json`),
 *    lu à l'adresse que lit aussi l'assistant (`HELP_CENTER_URL` serveur,
 *    puis `NEXT_PUBLIC_PUBLIC_SITE_URL`).
 * 2. À défaut, corpus de l'assistant (`/aide/corpus-t2.json`, même site,
 *    mêmes IDs, titres et adresses ; articles publiés seulement ; dernier
 *    corpus valide PUB-01 ; contrôle d'environnement ENV-02).
 * 3. Sinon : aucune source (`none`) — la fenêtre affiche son repli explicite.
 *
 * Un ID inconnu ou non publié reste masqué (§13) quelle que soit la source.
 */
import {
  HELP_T2_CORPUS_PATH, fetchHelpCatalog, resolveShortcuts, shortcutIdsForRoute, type ResolvedShortcut,
} from '@/lib/help-center/catalog';
import {
  HELP_CORPUS_OPEN_BUDGET_MS, loadHelpCorpus, resolveHelpCorpusConfig, type HelpCorpus,
} from '@/services/verebona-assistant/core/help-corpus.service';

export type HelpShortcutsSource = 'catalogue' | 'corpus' | 'none';

/** Site public de l'environnement, tel que le lit l'assistant (sans le chemin du corpus). */
export function serverHelpSiteBase(): string | undefined {
  try {
    const url = resolveHelpCorpusConfig().url;
    return url && url.endsWith(HELP_T2_CORPUS_PATH) ? url.slice(0, -HELP_T2_CORPUS_PATH.length) : undefined;
  } catch {
    return undefined;
  }
}

/** Raccourcis tirés du corpus de l'assistant : IDs demandés, dans leur ordre, articles publiés seulement. */
export function shortcutsFromCorpus(corpus: Pick<HelpCorpus, 'articles'> | null, ids: readonly string[]): ResolvedShortcut[] {
  if (!corpus) return [];
  const byId = new Map(corpus.articles.map((a) => [a.id, a]));
  return ids.flatMap((id) => {
    const a = byId.get(id);
    return a && typeof a.title === 'string' && a.title.trim() && /^\/aide\/[a-z0-9-]+$/.test(a.path)
      ? [{ id: a.id, title: a.title, path: a.path }]
      : [];
  });
}

async function corpusBorne(budgetMs: number): Promise<HelpCorpus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadHelpCorpus({ staleWhileRevalidate: true }).catch(() => null),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), budgetMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveHelpShortcutsOnServer(
  route: string,
  opts: { corpusBudgetMs?: number } = {},
): Promise<{ source: HelpShortcutsSource; shortcuts: ResolvedShortcut[] }> {
  const ids = shortcutIdsForRoute(route);
  const catalog = await fetchHelpCatalog(serverHelpSiteBase());
  if (catalog) return { source: 'catalogue', shortcuts: resolveShortcuts(catalog, ids) };
  const fromCorpus = shortcutsFromCorpus(await corpusBorne(opts.corpusBudgetMs ?? HELP_CORPUS_OPEN_BUDGET_MS), ids);
  if (fromCorpus.length > 0) return { source: 'corpus', shortcuts: fromCorpus };
  console.warn('[aide] Accès rapides indisponibles : ni catalogue ni corpus du Centre d’aide lisibles.');
  return { source: 'none', shortcuts: [] };
}
