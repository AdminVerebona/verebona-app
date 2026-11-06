/**
 * Lot 113G (ticket #706) — les DEUX fiches d'une carte « S’agit-il du même
 * fournisseur ? », entre la question et les boutons Oui / Non.
 *
 *   Fournisseur détecté : [nom fiche A]   SIREN · ville · n documents
 *   Fournisseur déjà connu : [nom fiche B]
 *
 * Seules les informations présentes sont affichées (jamais inventées) ; chaque
 * nom ouvre SA fiche par son identifiant (aucune recherche par nom). Rendu
 * SEUL : le serveur fournit noms et informations (aucune règle ici). Lisible à
 * 320 px (passage à la ligne, aucune troncature) ; couleurs par jetons.
 * Composant SANS hook (testé en l'appelant comme une fonction).
 */
import { supplierHref } from '@/lib/supplier-routes';
import type { SupplierPairView, SupplierPairSide } from '@/services/to-process/supplier-identity-cards';

/** Informations discriminantes d'une fiche (pure) : SIREN, ville, nombre de documents — présentes seulement. */
export function supplierPairFacts(s: SupplierPairSide): string[] {
  return [
    s.siren ? `SIREN ${s.siren}` : null,
    s.city,
    s.documents > 0 ? `${s.documents} document${s.documents > 1 ? 's' : ''}` : null,
  ].filter((x): x is string => !!x);
}

function Side({ label, side, testId }: { label: string; side: SupplierPairSide; testId: string }) {
  const facts = supplierPairFacts(side);
  return (
    <li data-supplier-pair-side={testId} className="flex min-w-0 flex-col">
      <span className="text-[11px] leading-snug text-muted-foreground">{label}</span>
      <a href={supplierHref(side.id)} className="text-sm font-medium text-[color:var(--accent)] underline-offset-2 hover:underline focus-visible:underline [overflow-wrap:anywhere]">
        {side.name}
      </a>
      {facts.length > 0 && <span className="text-[11px] leading-snug text-muted-foreground">{facts.join(' · ')}</span>}
    </li>
  );
}

export function SupplierPairDetails({ pair }: { pair: SupplierPairView }) {
  return (
    <ul data-card-supplier-pair className="mt-2 max-w-full space-y-1.5 border-l-2 border-[color:var(--border)] pl-3">
      <Side label="Fournisseur détecté :" side={pair.detected} testId="detected" />
      <Side label="Fournisseur déjà connu :" side={pair.known} testId="known" />
    </ul>
  );
}
