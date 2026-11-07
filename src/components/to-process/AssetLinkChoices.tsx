'use client';

/**
 * Lot 113A (#692, régression P1) — choix du bien sur une carte « À quel bien
 * rattacher ce document ? » (règle LINK-ASSET), mobile et ordinateur.
 *
 * · Un bouton NOMMÉ par bien pouvant recevoir le document (liste du serveur,
 *   `asset-link-choices.ts`) : candidats de l'analyse d'abord, en évidence,
 *   puis les autres biens. Aucun « Ouvrir » ni « Autre » : les choix ne sont
 *   jamais cachés derrière une étape.
 * · Clic = rattachement par le parcours commun de la file (`onChoose` →
 *   route `/resolve`, mode `arbitrate`, écrivain canonique) — aucune logique
 *   de rattachement ici.
 * · Plusieurs biens : les boutons passent à la ligne entre eux et dans leur
 *   libellé (classe des propositions, lot 60A), zone tactile de 36 px au
 *   moins, aucun défilement horizontal à 320 px.
 * · Liste vide ou illisible : état écrit, jamais un bouton trompeur ; l'erreur
 *   propose seulement de recharger la file.
 * · Composant SANS hook (testé en l'appelant comme une fonction).
 * · Lot 113V (#719) : « Aucun » DIRECTEMENT à côté des biens (et sous l'état
 *   vide) — non-rattachement explicite, même parcours (`onNone` → route
 *   `/resolve`, valeur `NONE`). Bouton neutre : ni mis en avant, ni caché
 *   derrière « Ouvrir ». Absent en cas d'erreur (on ne refuse pas une liste
 *   qu'on n'a pas vue).
 */
import { Button } from '@/components/ui/button';
import type { AssetLinkChoicesView } from '@/services/to-process/asset-link-choices';
import { NO_ASSET_CHOICE_LABEL } from '@/services/to-process/no-asset-choice';
import { PROPOSAL_BUTTON_CLASS } from './proposal-button';

/** Textes de la carte (états vide / erreur, nom accessible du groupe et des boutons). */
export const ASSET_LINK_TEXT = {
  group: 'Rattacher ce document à un bien',
  button: (label: string) => `Rattacher à ${label}`,
  empty: 'Aucun bien de votre compte ne peut recevoir ce document pour le moment. Ajoutez d’abord le bien concerné, puis revenez ici.',
  error: 'La liste de vos biens n’a pas pu être chargée.',
  retry: 'Réessayer',
  /** Lot 113V : libellé du ticket #719 ; nom accessible à valider par le PO. */
  none: NO_ASSET_CHOICE_LABEL,
  noneAria: 'Aucun de ces biens : laisser ce document sans bien',
} as const;

interface Props {
  choices: AssetLinkChoicesView;
  busy?: boolean;
  onPick: (choice: { assetId: number; label: string }) => void;
  onRetry: () => void;
  /** Lot 113V : « Aucun » — non-rattachement explicite (absent : bouton non affiché). */
  onNone?: () => void;
}

/** Lot 113V : bouton « Aucun » (neutre, même zone tactile que les biens). */
function NoneButton({ busy, onNone }: { busy?: boolean; onNone: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      data-asset-choice="none"
      aria-label={ASSET_LINK_TEXT.noneAria}
      onClick={() => onNone()}
      className={PROPOSAL_BUTTON_CLASS}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{ASSET_LINK_TEXT.none}</span>
    </Button>
  );
}

export function AssetLinkChoices({ choices, busy, onPick, onRetry, onNone }: Props) {
  if (choices.status === 'ERROR') {
    return (
      <div data-asset-choices="error" role="alert" className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="[overflow-wrap:anywhere]">{ASSET_LINK_TEXT.error}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetry} className="h-9">
          {ASSET_LINK_TEXT.retry}
        </Button>
      </div>
    );
  }
  if (choices.status === 'EMPTY' || choices.items.length === 0) {
    const vide = (
      <p data-asset-choices="empty" className="max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {ASSET_LINK_TEXT.empty}
      </p>
    );
    if (!onNone) return vide;
    return (
      <div className="flex min-w-0 max-w-full flex-col items-start gap-2">
        {vide}
        <NoneButton busy={busy} onNone={onNone} />
      </div>
    );
  }
  return (
    <div data-asset-choices="ok" role="group" aria-label={ASSET_LINK_TEXT.group} className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {choices.items.map((c) => (
        <Button
          key={c.assetId}
          type="button"
          size="sm"
          variant={c.suggested ? 'default' : 'outline'}
          disabled={busy}
          data-asset-choice={c.assetId}
          data-suggested={c.suggested ? 'true' : undefined}
          aria-label={ASSET_LINK_TEXT.button(c.label)}
          onClick={() => onPick({ assetId: c.assetId, label: c.label })}
          className={PROPOSAL_BUTTON_CLASS}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{c.label}</span>
        </Button>
      ))}
      {onNone && <NoneButton busy={busy} onNone={onNone} />}
    </div>
  );
}
