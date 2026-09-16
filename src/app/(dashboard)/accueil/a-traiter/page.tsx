/**
 * À traiter — file unique d'actions. CDC V2.0 §7 et §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA V1 A ÉTÉ RETIRÉE, PAS MISE DE CÔTÉ
 *
 * Cette page comptait 1 215 lignes et quatre onglets — documents, agenda,
 * équipements, fournisseurs — chacun avec ses propres actions, ses propres
 * compteurs et son propre vocabulaire.
 *
 * Le §7.1 remplace tout cela par une file unique où « une carte représente
 * une action, pas un objet ». Les onglets ne sont pas une présentation
 * différente de la même chose : ils sont exactement ce que le CDC supprime.
 * Les garder sous un drapeau aurait laissé vivre deux modèles mentaux dans le
 * même produit, et personne n'aurait su lequel fait foi.
 *
 * Le contenu tient désormais dans `ToProcessQueue`, qui lit la file V2
 * alimentée par le traitement d'optimisation.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { ToProcessQueue } from '@/components/to-process/ToProcessQueue';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'À traiter — Verebona',
};

export default function ATraiterPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <ToProcessQueue />
    </main>
  );
}
