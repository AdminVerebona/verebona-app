"use client";

/**
 * Option « Sans échéance » d'un événement d'agenda — lot 77A (décision PO du
 * 21/10/2026).
 *
 * Un seul composant pour les deux tiroirs (création `CreateAgendaItemDrawer`,
 * modification `AgendaItemDrawer`), eux-mêmes communs à tous les points
 * d'entrée (« Mon agenda », onglet Agenda d'un bien, équipement, document,
 * accueil, « + » desktop et mobile — feuille pleine largeur sur mobile).
 *
 * Case à cocher de la charte (`Checkbox`), libellé cliquable, aide courte.
 * Cocher alors qu'une date est saisie demande une confirmation (la date sera
 * retirée) ; la logique d'état est pure (`@/lib/agenda/no-deadline`).
 */
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  NO_DEADLINE_CONFIRM_BODY,
  NO_DEADLINE_CONFIRM_TITLE,
  NO_DEADLINE_HELP,
  NO_DEADLINE_LABEL,
  needsNoDeadlineConfirm,
  type AgendaDateFormState,
} from "@/lib/agenda/no-deadline";

interface Props {
  /** Identifiant DOM (libellé et aide reliés à la case). */
  id: string;
  /** Dates du formulaire et option : cocher alors qu'une date est saisie demande confirmation. */
  state: AgendaDateFormState;
  /** Nouvelle valeur, après confirmation si nécessaire. */
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function NoDeadlineField({ id, state, onChange, disabled }: Props) {
  const checked = state.noDeadline;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const helpId = `${id}-aide`;

  const demander = (next: boolean) => {
    if (needsNoDeadlineConfirm(state, next)) {
      setConfirmOpen(true);
      return;
    }
    onChange(next);
  };

  return (
    <div className="flex items-start gap-2.5" data-testid="agenda-sans-echeance">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={helpId}
        onCheckedChange={(v) => demander(v === true)}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-[color:var(--text-primary)] cursor-pointer">
          {NO_DEADLINE_LABEL}
        </label>
        <p id={helpId} className="text-xs text-muted-foreground mt-0.5">
          {NO_DEADLINE_HELP}
        </p>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{NO_DEADLINE_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{NO_DEADLINE_CONFIRM_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Garder la date</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onChange(true);
              }}
            >
              Retirer la date
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

