/**
 * LIEN TEXTUEL vers l'article d'aide ou la Ressource — Trello #753, CDC T2 §7.6, §8.1, §8.2, §8.3 (D24, M13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TITRE DE L'ARTICLE, CLIQUABLE ; LES BOUTONS SERVENT AUX ACTIONS
 *
 * Le renvoi à un article du Centre d'aide ou à une Ressource s'affichait en
 * BOUTON (« Lire l'article », « Lire la Ressource »), au même rang que les
 * actions. Le CDC demande l'inverse (§7.6) : « synthèse plutôt concise,
 * suivie du titre de l'article sous forme de texte cliquable… Jamais un
 * bouton « Voir la source » automatique. Les boutons servent aux actions. »
 *
 * Le titre est celui du corpus LU PAR LE SERVEUR (source `help_entry`), pas
 * un texte du modèle, et l'adresse reste celle que le serveur a construite
 * (chemin contrôlé, `buildHref`) : rien n'est repris d'une sortie de modèle.
 * Une action d'aide sans article identifié (accueil du Centre d'aide,
 * recherche) garde son bouton : elle n'a pas de titre à montrer.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaAction } from '../types/actions';
import type { RetrievedSource } from '../types/sources';

/** Titre de l'ARTICLE d'une source d'aide (son titre porte « Article — Section »). */
export function helpArticleTitle(source: Pick<RetrievedSource, 'title'>): string {
  return String(source.title ?? '').split(' — ')[0].trim();
}

/** Chemin d'un article, sans ancre ni paramètre (comparaison de deux chemins du serveur). */
const chemin = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.split('#')[0].split('?')[0].replace(/\/+$/, '') : '';
  return t ? t : null;
};

/** Longueur gardée d'un titre affiché en lien (au-delà : le lien n'est pas lisible d'un coup d'œil). */
const TITRE_MAX = 120;

/**
 * Attache à chaque action d'aide le TITRE de son article, quand les sources lues le portent (pure, testée).
 *
 * L'article est reconnu par son identifiant (`helpEntryId` = `targetRef`) ou, à défaut, par son CHEMIN : ce sont
 * les deux clés que le serveur a lui-même posées sur l'action. Aucun titre inventé, aucun rapprochement par les
 * mots : sans correspondance exacte, l'action est rendue telle quelle (donc affichée en bouton, comme avant).
 */
export function withHelpArticleLinks(actions: VerebonaAction[], sources: readonly RetrievedSource[]): VerebonaAction[] {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length === 0) return actions;
  const parArticle = new Map<string, string>();
  const parChemin = new Map<string, string>();
  for (const s of aide) {
    const titre = helpArticleTitle(s);
    if (!titre || titre.length > TITRE_MAX) continue;
    const id = typeof s.meta?.articleId === 'string' ? s.meta.articleId : null;
    const p = chemin(s.meta?.path);
    // Première source de l'article : la plus pertinente (l'ordre des sources est celui du serveur).
    if (id && !parArticle.has(id)) parArticle.set(id, titre);
    if (p && !parChemin.has(p)) parChemin.set(p, titre);
  }
  return actions.map((a) => {
    if (a.type !== 'OPEN_HELP' || !a.href || a.linkTitle) return a;
    // Recherche du Centre d'aide (`search: true`) : aucun article précis, donc aucun lien textuel.
    if (a.payload?.search === true) return a;
    const id = typeof a.payload?.helpEntryId === 'string' ? a.payload.helpEntryId : a.targetRef ?? null;
    const p = chemin(a.payload?.path) ?? chemin(a.href);
    const titre = (id ? parArticle.get(id) : null) ?? (p ? parChemin.get(p) : null) ?? null;
    // Le titre est aussi rangé dans les paramètres validés de l'action : la MÊME demande rejouée
    // (idempotence) restitue le même lien textuel, sans rien chercher à nouveau et sans migration.
    return titre ? { ...a, linkTitle: titre, payload: { ...(a.payload ?? {}), linkTitle: titre } } : a;
  });
}
