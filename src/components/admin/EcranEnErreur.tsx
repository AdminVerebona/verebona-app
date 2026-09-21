"use client";

/**
 * État d'erreur d'un écran d'administration.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE COMPOSANT EXISTE
 *
 * Les six écrans du Back-Office IA affichaient « Chargement… » INDÉFINIMENT
 * quand leur route échouait : le témoin de chargement ne se retirait que si les
 * données arrivaient. Constaté en recette le 21/09/2026 sur le tableau de bord.
 *
 * Un écran qui charge pour toujours est pire qu'un écran en erreur : on attend,
 * on recharge, on doute de sa connexion, et l'on finit par ouvrir les outils de
 * développement pour découvrir une réponse 500 vieille de trois minutes.
 *
 * Le message du serveur est affiché tel quel. Il porte un code stable —
 * VERSION_NOT_FOUND, CONFIG_OPERATION_FAILED — qui vaut mieux qu'un
 * « une erreur est survenue » dont personne ne peut rien faire.
 */

import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export function EcranEnErreur({
  titre, message, onRetry,
}: { titre: string; message?: string | null; onRetry: () => void }) {
  return (
    <div className="max-w-xl rounded-xl border border-red-500/30 bg-red-500/5 p-6 space-y-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">{titre}</h2>
          <p className="text-sm text-[color:var(--text-secondary)]">
            {message ?? "Le serveur n'a pas répondu comme attendu."}
          </p>
          <p className="text-xs text-[color:var(--text-muted)]">
            Si le problème persiste, le détail complet est dans les journaux du serveur.
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Réessayer
      </Button>
    </div>
  );
}
