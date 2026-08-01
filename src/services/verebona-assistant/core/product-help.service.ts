/**
 * Aide produit — CDC §10.
 *
 * Recherche déterministe dans la base d'aide versionnée
 * (`verebona_help_entries`), plein texte + motifs de question, filtrée par
 * offre. Ne dépend d'aucun modèle (§14.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX DÉFAUTS CORRIGÉS ICI
 *
 * · `plan_scope` ÉTAIT IGNORÉ. La fonction recevait `planType` et ne s'en
 *   servait pas : un compte Standard pouvait se voir proposer un article
 *   réservé à Premium, puis découvrir que la fonction décrite ne lui est pas
 *   accessible. C'est le plus gênant des deux — un paramètre reçu et non
 *   employé donne à croire que le filtrage a lieu.
 *
 * · `question_patterns` N'ÉTAIT PAS CHERCHÉ. La colonne existe précisément
 *   pour cela (§10.4) : elle contient les formulations réelles des
 *   utilisateurs — « comment je supprime un bien », « ça sert à quoi les
 *   catégories ». Ne chercher que dans le titre suppose que l'utilisateur
 *   connaisse le vocabulaire du produit, ce qui est rarement le cas quand on
 *   cherche de l'aide.
 *
 * ── LA RECHERCHE IGNORE ACCENTS ET CASSE ──────────────────────────────────
 *
 * `unaccent` est installée par la migration 0060. Sans elle, « supprimer une
 * échéance » ne trouverait pas un article intitulé « Supprimer une echeance ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export interface HelpHit {
  slug: string;
  title: string;
  shortAnswer: string;
  detailedAnswer?: string | null;
}

/**
 * Cherche un article d'aide accessible à l'offre du compte.
 *
 * @param planType offre du compte — `STANDARD`, `PREMIUM`, `PREMIUM_DUO`…
 */
export async function searchHelp(
  query: string,
  planType: string,
  locale = 'fr-FR',
): Promise<HelpHit[]> {
  const terme = query.trim();
  if (terme.length < 2) return [];

  const motif = `%${terme}%`;
  const offre = (planType || 'STANDARD').toUpperCase();

  const rows = await pgClient<
    Array<{ slug: string; title: string; short_answer: string; detailed_answer: string | null }>
  >`
    SELECT slug, title, short_answer, detailed_answer
      FROM verebona_help_entries
     WHERE status = 'published'
       AND locale = ${locale}
       -- §10 : un article vide de portée s'adresse à toutes les offres ;
       -- sinon il doit nommer celle du compte.
       AND (
         plan_scope = '[]'::jsonb
         OR plan_scope @> ${JSON.stringify([offre])}::jsonb
       )
       AND (
         unaccent(lower(title))        LIKE unaccent(lower(${motif}))
         OR unaccent(lower(short_answer)) LIKE unaccent(lower(${motif}))
         -- §10.4 : les formulations réelles des utilisateurs, qui emploient
         -- rarement le vocabulaire du produit.
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(question_patterns) = 'array'
                  THEN question_patterns ELSE '[]'::jsonb END
           ) AS p(motif_question)
           WHERE unaccent(lower(p.motif_question)) LIKE unaccent(lower(${motif}))
         )
       )
     -- Un article dont un MOTIF correspond passe devant : il a été écrit pour
     -- cette question précise, là où une correspondance de titre peut être
     -- fortuite.
     ORDER BY
       CASE WHEN EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(question_patterns) = 'array'
                THEN question_patterns ELSE '[]'::jsonb END
         ) AS p2(motif_question)
         WHERE unaccent(lower(p2.motif_question)) LIKE unaccent(lower(${motif}))
       ) THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 3
  `;

  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    shortAnswer: r.short_answer,
    detailedAnswer: r.detailed_answer,
  }));
}
