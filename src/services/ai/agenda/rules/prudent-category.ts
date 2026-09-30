/**
 * Classification prudente — CDC 15 T4-10, §26 C5, D-14.
 *
 * Une classification `unknown` (modèle abstenu) ou ambiguë n'est jamais
 * affichée « au hasard ». Règle documentée :
 *   · échéance FUTURE (ou non datée)  → `action` : visible dans « Prochaines
 *     dates » et rappelée — une action manquée coûte plus qu'une ligne en trop
 *     (même choix que le repli historique en cas d'échec du modèle) ;
 *   · date PASSÉE                     → `information` : un fait passé n'est
 *     jamais une tâche en retard ni une notification (D-14).
 * Dans les deux cas `requiresQualification = true` : la catégorie est à
 * confirmer par l'utilisateur (colonne `requires_qualification` existante,
 * écrite par la persistance).
 */
import type { AgendaClassification, HomeCategory } from '../types';

export function prudentCategory(
  c: AgendaClassification, opts: { date?: string | null; today: string },
): { category: HomeCategory; requiresQualification: boolean } {
  if (c.category !== 'unknown' && c.confidence !== 'ambiguous') {
    return { category: c.category, requiresQualification: false };
  }
  if (c.category !== 'unknown') return { category: c.category, requiresQualification: true };
  const passee = Boolean(opts.date) && (opts.date as string) < opts.today;
  return { category: passee ? 'information' : 'action', requiresQualification: true };
}
