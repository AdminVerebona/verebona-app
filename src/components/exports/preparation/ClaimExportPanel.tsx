"use client"

/**
 * Sinistre du dossier Assurance-sinistre dans l'écran de préparation (lot 44,
 * O5 ; décisions PO Q2, Q3, Q11) :
 *
 *   · plusieurs sinistres sur le bien → choix du sinistre du dossier (la
 *     pré-sélection des événements, documents et photos suit sa date) ;
 *   · formulaire du sinistre retenu, intégré (`ClaimEditor compact`) : une
 *     valeur saisie ici EST celle de la fiche ;
 *   · aucun sinistre → ajout ; ancienne saisie encore lue → invitation à la
 *     reprendre depuis la fiche (rubrique « Sinistres »).
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import type { AutosaveState } from '@/lib/assets/additional-infos-autosave';
import { ClaimEditor, type ClaimResponse } from '@/components/assets/claims/ClaimEditor';
import type { PreparationDto } from '@/services/exports/v12/preparation/types';

interface Props {
  assetId: number;
  category: string;
  claim: NonNullable<PreparationDto['claim']>;
  editable: boolean;
  onSelect: (claimOperationId: number) => void;
  onSaveStateChange: (s: AutosaveState) => void;
}

export function ClaimExportPanel({ assetId, category, claim, editable, onSelect, onSaveStateChange }: Props) {
  const [assetOptions, setAssetOptions] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stop = false;
    apiClient.get<{ assetOptions: Array<{ id: number; name: string }> }>(`/api/assets/${assetId}/claims`)
      .then((d) => { if (!stop) setAssetOptions(d.assetOptions ?? []); })
      .catch(() => undefined);
    return () => { stop = true; };
  }, [assetId]);

  const ajouter = () => {
    setBusy(true);
    apiClient.post<ClaimResponse>(`/api/assets/${assetId}/claims`, {})
      .then((c) => onSelect(c.id))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4" data-claim-export>
      {claim.options.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor={`claim-export-${assetId}`} className="text-xs text-muted-foreground font-medium">Sinistre du dossier</Label>
          <Select value={String(claim.selectedOperationId ?? '')} disabled={!editable} onValueChange={(v) => onSelect(Number(v))}>
            <SelectTrigger id={`claim-export-${assetId}`} className="w-full text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {claim.options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground/80 leading-snug">Ce bien a plusieurs sinistres : les éléments proposés suivent celui que vous choisissez.</p>
        </div>
      )}
      {claim.selectedOperationId !== null ? (
        <ClaimEditor
          key={claim.selectedOperationId}
          assetId={assetId}
          claimId={claim.selectedOperationId}
          category={category}
          assetOptions={assetOptions}
          readOnly={!editable}
          compact
          onSaveStateChange={onSaveStateChange}
        />
      ) : (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {claim.origin === 'legacy'
              ? 'Le dossier reprend votre saisie précédente. Reprenez-la en sinistre dans la fiche du bien (rubrique « Sinistres ») pour la compléter.'
              : 'Aucun sinistre n’est enregistré pour ce bien.'}
          </p>
          {editable && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={ajouter}>Ajouter un sinistre</Button>
          )}
        </div>
      )}
    </div>
  );
}
