'use client';

/**
 * Champ « Bien mis en location » — CDC V2.0 §6.1, §6.2, §16.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX BOUTONS, TROIS ÉTATS
 *
 * Le §6.1 distingue « Non » répondu par l'utilisateur et « Non » posé par
 * défaut, sans demander d'afficher le troisième état. C'est cohérent : ce que
 * l'utilisateur doit voir, c'est la question et sa réponse, pas la mécanique
 * de protection derrière.
 *
 * La nuance reste visible d'une autre façon — la mention sous les boutons
 * disparaît une fois la réponse donnée. Tant qu'elle est là, la question est
 * ouverte ; quand elle s'efface, c'est que Verebona a enregistré une réponse.
 *
 * ── RÉPONDRE « NON » N'EST PAS UN GESTE NEUTRE ────────────────────────────
 *
 * Cliquer sur « Non » protège la valeur (§6.1) : l'IA ne pourra plus la
 * modifier, seulement proposer un arbitrage. C'est exactement ce qu'on attend
 * d'une réponse explicite, et c'est pourquoi le bouton n'est pas préactivé au
 * chargement — un état par défaut qui ressemble à un choix finirait par en
 * tenir lieu.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface RentalStatus {
  isRented: boolean;
  userValidated: boolean;
  state: 'NON_RENSEIGNE' | 'NON' | 'OUI';
}

export function RentalStatusField({
  assetId,
  readOnly = false,
  onChanged,
}: {
  assetId: number;
  readOnly?: boolean;
  /** Permet au parent de rafraîchir la visibilité de « Gestion locative » (§6.2). */
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<RentalStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiClient.get<RentalStatus>(`/api/v2/assets/${assetId}/rental`));
    } catch {
      // Le champ ne s'applique qu'à l'immobilier : une erreur ici signifie le
      // plus souvent « pas applicable », et le composant disparaît sans bruit.
      setStatus(null);
    }
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (isRented: boolean) => {
    setSaving(true);
    try {
      const next = await apiClient.patch<RentalStatus>(
        `/api/v2/assets/${assetId}/rental`,
        { isRented },
      );
      setStatus(next);
      onChanged?.();
    } catch {
      toast.error('Le statut de location n’a pas pu être enregistré.');
    } finally {
      setSaving(false);
    }
  };

  if (!status) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Bien mis en location</p>
        {status.state === 'NON_RENSEIGNE' && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Cette information n’a pas encore été renseignée.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2" role="group" aria-label="Bien mis en location">
        {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {/* §16.2 : l'état sélectionné est porté par aria-pressed et par la
            variante, jamais par la couleur seule. */}
        <Button
          size="sm"
          variant={status.state === 'OUI' ? 'default' : 'outline'}
          aria-pressed={status.state === 'OUI'}
          disabled={saving || readOnly}
          onClick={() => choose(true)}
        >
          Oui
        </Button>
        <Button
          size="sm"
          variant={status.state === 'NON' ? 'default' : 'outline'}
          aria-pressed={status.state === 'NON'}
          disabled={saving || readOnly}
          onClick={() => choose(false)}
        >
          Non
        </Button>
      </div>
    </div>
  );
}
