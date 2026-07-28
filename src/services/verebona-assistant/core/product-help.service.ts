/**
 * Aide produit — CDC §10.
 *
 * Recherche déterministe dans la base d'aide versionnée (`verebona_help_entries`),
 * plein texte + synonymes, filtrée par offre. Réponse courte + action d'ouverture.
 * Ne dépend pas de Gemini (déterministe — §14.2) sauf reformulation optionnelle
 * PRODUCT_HELP_HOW_TO (offre éligible), toujours à partir d'un article existant.
 */
import { pgClient } from '@/db';

export interface HelpHit {
  slug: string;
  title: string;
  shortAnswer: string;
  detailedAnswer?: string | null;
}

export async function searchHelp(query: string, planType: string, locale = 'fr-FR'): Promise<HelpHit[]> {
  // TODO(CDC §10.4) : indexer question_patterns + synonymes ; ici recherche ILIKE simple.
  const rows = await pgClient.unsafe(
    `SELECT slug, title, short_answer, detailed_answer
       FROM verebona_help_entries
      WHERE status = 'published' AND locale = $1
        AND (title ILIKE $2 OR short_answer ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT 3`,
    [locale, `%${query}%`],
  );
  return (rows as unknown as Array<{ slug: string; title: string; short_answer: string; detailed_answer: string | null }>).map((r) => ({
    slug: r.slug, title: r.title, shortAnswer: r.short_answer, detailedAnswer: r.detailed_answer,
  }));
}
