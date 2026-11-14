"use client";

/**
 * « Situation de l'événement » — sélecteur segmenté à deux options, lot 114V
 * (Trello #742, décision PO du 14/11/2026).
 *
 * Un seul composant pour les deux tiroirs (création `CreateAgendaItemDrawer`,
 * modification `AgendaItemDrawer`), eux-mêmes communs à tous les points
 * d'entrée (« Mon agenda », onglet Agenda d'un bien, équipement, document,
 * accueil, « + » desktop et mobile — feuille pleine largeur sur mobile).
 *
 *   · à GAUCHE « A eu lieu », à DROITE « À prévoir » (ordre de
 *     `AGENDA_SITUATIONS`) ; en création, « À prévoir » est présélectionné et
 *     enregistré sans aucun clic ;
 *   · en modification, la valeur PERSISTÉE est sélectionnée ; un élément non
 *     qualifié (hérité) n'a AUCUN segment sélectionné — rien n'est présumé ;
 *   · ce n'est ni un interrupteur ni deux cases : un groupe de boutons radio
 *     (`role="radiogroup"` / `role="radio"`, `aria-checked`), un seul arrêt
 *     de tabulation, flèches gauche / droite (et haut / bas) pour changer,
 *     Espace / Entrée pour choisir ; l'anneau de focus est celui de la charte
 *     (règle globale `:focus-visible`) ;
 *   · style du contrôle segmenté du design system (pilule, segment actif en
 *     couleur d'accent plein) — jetons de la charte, aucune couleur brute ;
 *     deux segments de même largeur, 40 px de haut (zone tactile mobile).
 * La date reste libre dans les deux cas : ce champ ne masque ni ne vide rien.
 */
import { useRef, type KeyboardEvent } from "react";
import {
  AGENDA_SITUATIONS,
  SITUATION_FIELD_LABEL,
  SITUATION_LABELS,
  type AgendaSituation,
} from "@/lib/agenda/situation";

interface Props {
  /** Identifiant DOM (libellé relié au groupe). */
  id: string;
  /** Situation sélectionnée ; `null` : aucune (élément hérité non qualifié). */
  value: AgendaSituation | null;
  onChange: (next: AgendaSituation) => void;
  disabled?: boolean;
  /** Classe du libellé (les deux tiroirs n'ont pas la même typographie de champ). */
  labelClassName?: string;
}

export function SituationField({ id, value, onChange, disabled, labelClassName }: Props) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const labelId = `${id}-libelle`;
  // Un seul arrêt de tabulation : le segment sélectionné, sinon le premier.
  const tabStop = value ? AGENDA_SITUATIONS.indexOf(value) : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + AGENDA_SITUATIONS.length) % AGENDA_SITUATIONS.length;
    onChange(AGENDA_SITUATIONS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="space-y-1.5" data-testid="agenda-situation">
      <p id={labelId} className={labelClassName ?? "text-sm font-medium leading-none text-[color:var(--text-primary)]"}>
        {SITUATION_FIELD_LABEL}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-disabled={disabled || undefined}
        className="grid w-full grid-cols-2 gap-0.5 rounded-[10px] border border-[color:var(--border)] bg-[color:var(--bg-card)] p-[3px]"
      >
        {AGENDA_SITUATIONS.map((s, index) => {
          const on = s === value;
          return (
            <button
              key={s}
              ref={(el) => { refs.current[index] = el; }}
              type="button"
              role="radio"
              aria-checked={on}
              data-situation={s}
              tabIndex={index === tabStop ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(s)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`min-h-10 rounded-[8px] px-3 text-[13px] font-semibold leading-tight transition-colors duration-[180ms] disabled:cursor-not-allowed disabled:opacity-50 ${
                on
                  ? "bg-[color:var(--accent)] text-[color:var(--on-accent)]"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              }`}
            >
              {SITUATION_LABELS[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
