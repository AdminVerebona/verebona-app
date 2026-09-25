/**
 * Écran cible du back-office pas encore livré — CDC Back-Office V1 §3.
 *
 * La navigation cible (REC-NAV-01) impose l'entrée dès maintenant ; l'écran
 * lui-même est construit par un lot ultérieur. Plutôt qu'un 404, l'entrée
 * mène à cette page, qui dit ce qui viendra et ne montre aucune donnée
 * partielle (ERR-001).
 */
import { Construction } from 'lucide-react';

export function EcranEnCoursDeRealisation({
  titre,
  description,
  references,
}: {
  titre: string;
  description: string;
  /** Sections du CDC couvertes par l'écran à venir. */
  references: string;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">{titre}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="max-w-xl rounded-xl border bg-card p-6 flex items-start gap-3">
        <Construction className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">Écran en cours de réalisation</p>
          <p className="text-sm text-muted-foreground">
            Cet écran sera livré dans un prochain lot du back-office ({references}).
          </p>
        </div>
      </div>
    </div>
  );
}
