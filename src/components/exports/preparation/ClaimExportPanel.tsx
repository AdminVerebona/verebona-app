"use client"

/**
 * Sinistre du dossier Assurance-sinistre dans l'écran de préparation (lot 44,
 * O5, Q2 ; refonte lot 83D — CDC v5 §15, §16 ; arbitrages V-Q1, V-Q8).
 *
 *   · plusieurs sinistres sur le bien → choix du sinistre du dossier (la
 *     pré-sélection des événements, documents et photos suit ce sinistre) ;
 *   · aucun formulaire : le dossier reprend ce que les documents ont établi
 *     (type, dates, références, dommages, chronologie, pièces et
 *     équipements). Aucune saisie ni création de sinistre ici (V-Q1 : pas de
 *     module Sinistres de remplacement) ;
 *   · aucun sinistre connu → invitation à ajouter ses documents.
 *
 * Même composant sur ordinateur et sur mobile (pleine largeur, textes à la ligne).
 */
import NextLink from 'next/link';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PreparationDto } from '@/services/exports/v12/preparation/types';

interface Props {
  assetId: number;
  claim: NonNullable<PreparationDto['claim']>;
  editable: boolean;
  onSelect: (claimOperationId: number) => void;
}

export function ClaimExportPanel({ assetId, claim, editable, onSelect }: Props) {
  const choisi = claim.options.find((o) => o.id === claim.selectedOperationId) ?? null;
  return (
    <div className="space-y-3" data-claim-export>
      {claim.options.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor={`claim-export-${assetId}`} className="text-xs text-muted-foreground font-medium">Sinistre du dossier</Label>
          <Select value={String(claim.selectedOperationId ?? '')} disabled={!editable} onValueChange={(v) => onSelect(Number(v))}>
            <SelectTrigger id={`claim-export-${assetId}`} className="w-full text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {claim.options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground/80 leading-snug break-words">Ce bien a plusieurs sinistres : les éléments proposés suivent celui que vous choisissez.</p>
        </div>
      ) : choisi ? (
        <p className="text-sm font-medium break-words" data-claim-export-label>{choisi.label}</p>
      ) : null}
      <p className="text-xs text-muted-foreground leading-snug break-words">
        {claim.selectedOperationId !== null
          ? 'Le dossier reprend ce que vos documents établissent : type, dates, références, dommages, étapes, pièces et équipements concernés.'
          : 'Aucun sinistre n’est connu pour ce bien. Ajoutez ses documents (déclaration, constat, courrier de l’assureur) : le dossier les reprendra.'}
      </p>
      {claim.selectedOperationId === null && (
        <NextLink href={`/assets/${assetId}?tab=documents`} className="inline-block text-xs font-medium text-primary underline-offset-2 hover:underline">
          Ajouter des documents
        </NextLink>
      )}
    </div>
  );
}
