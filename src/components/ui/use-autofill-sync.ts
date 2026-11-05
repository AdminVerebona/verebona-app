"use client";

import * as React from "react";

/**
 * Lot 111E — champ CONTRÔLÉ et remplissage automatique.
 *
 * Un gestionnaire de mots de passe peut poser la valeur d'un champ sans que
 * React la voie (valeur posée par le setter puis événement synthétique ignoré
 * par le suivi de valeur de React, remplissage avant le montage). L'état
 * React reste alors vide : bouton désactivé, envoi d'une valeur vide, ou
 * valeur effacée au rendu suivant.
 *
 * Ce crochet relit la valeur RÉELLE du champ après chaque événement natif
 * `input` / `change` et, au montage, à quelques instants (pré-remplissage),
 * et appelle `onChange` du composant si elle diffère de l'état. Il ne fait
 * rien pour un champ non contrôlé, ni quand l'état est déjà à jour (saisie
 * clavier normale). Aucune valeur n'est lue ailleurs que dans le champ, ni
 * journalisée.
 */
export function useAutofillSync(
  ref: React.RefObject<HTMLInputElement | null>,
  value: unknown,
  onChange: React.ChangeEventHandler<HTMLInputElement> | undefined,
) {
  // Mis à jour APRÈS validation du rendu : l'état comparé est celui du DOM affiché.
  const latest = React.useRef({ value, onChange });
  React.useLayoutEffect(() => {
    latest.current = { value, onChange };
  });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sync = () => {
      const { value: v, onChange: cb } = latest.current;
      if (!cb || typeof v !== "string" || el.disabled) return;
      if (el.value === v) return;
      const nativeEvent = new Event("change", { bubbles: true });
      cb({
        target: el, currentTarget: el, nativeEvent, type: "change", bubbles: true,
        isDefaultPrevented: () => false, isPropagationStopped: () => false,
        preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
      } as unknown as React.ChangeEvent<HTMLInputElement>);
    };
    // Après le traitement par React de l'événement (et son rendu).
    const later = () => { timers.push(setTimeout(sync, 0)); };
    el.addEventListener("input", later);
    el.addEventListener("change", later);
    for (const ms of [0, 200, 800, 2000]) timers.push(setTimeout(sync, ms));
    return () => {
      el.removeEventListener("input", later);
      el.removeEventListener("change", later);
      for (const t of timers) clearTimeout(t);
    };
  }, [ref]);
}

/** Réunit la référence transmise par le parent et la référence interne. */
export function useMergedInputRef(forwarded: React.ForwardedRef<HTMLInputElement>) {
  const inner = React.useRef<HTMLInputElement | null>(null);
  const setRef = React.useCallback((node: HTMLInputElement | null) => {
    inner.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [forwarded]);
  return [inner, setRef] as const;
}
