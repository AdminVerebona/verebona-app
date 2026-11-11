/**
 * Lot 113AL (Trello #737) — VÉRIFICATION, à chaque calcul, des représentations
 * établies par l'arbitrage sémantique T3 (pure, appelée par `computeTco`
 * avant les décisions de l'utilisateur).
 *
 * Un montant que T3 a reconnu comme autre source d'un fait DÉJÀ compté (prix
 * d'achat de la fiche, dépense consolidée, autre justificatif) n'est écarté
 * du total que tant que ce fait existe et reste RETENU : la ligne est alors
 * reliée au vrai fait (`duplicateOf`), justificatif consultable. Si le fait a
 * disparu ou n'est plus compté (correction, retrait, reconsolidation), la
 * ligne redevient « Nature à confirmer » avec l'état `STALE` — jamais un
 * montant perdu en silence ; le contrôle COH-TCO-EXTRACTED-EXPENSES voit une
 * empreinte nouvelle et demande un réexamen motivé. Un règlement reste un
 * règlement (jamais un coût), seule la liaison est retirée.
 */
import type { TcoEconomicLine } from './model';
import { tcoLineKeys } from './user-decisions';

const RETENUE = (s: TcoEconomicLine['status']) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';

/** Mutation : relie chaque ligne représentée à son fait compté, ou la rouvre (rend le nombre de lignes rouvertes). */
export function verifySemanticRepresentations(lines: TcoEconomicLine[]): number {
  const representees = lines.filter((l) => l.representedBy && l.semantic?.state === 'APPLIED');
  if (!representees.length) return 0;
  const parCle = new Map<string, TcoEconomicLine[]>();
  for (const l of lines) {
    if (!RETENUE(l.status)) continue;
    const k = tcoLineKeys(l);
    for (const c of [k.primary, ...k.secondary, l.id]) parCle.set(c, [...(parCle.get(c) ?? []), l]);
  }
  let rouvertes = 0;
  for (const l of representees) {
    const fait = (parCle.get(l.representedBy!) ?? []).find((x) => x !== l);
    if (fait) { l.duplicateOf = fait.id; continue; }
    delete l.duplicateOf;
    if (l.status === 'PAYMENT') { l.semantic = { ...l.semantic!, state: 'STALE' }; continue; }
    l.status = 'NOT_QUALIFIED';
    l.reason = 'THEME_UNKNOWN';
    l.includedCents = 0;
    l.note = 'Le fait déjà compté auquel ce montant avait été rattaché n’est plus retenu : nature à réexaminer.';
    l.semantic = { ...l.semantic!, state: 'STALE' };
    rouvertes += 1;
  }
  return rouvertes;
}
