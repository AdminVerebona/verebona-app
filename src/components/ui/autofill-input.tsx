"use client";

import * as React from "react";

import { Input } from "./input";
import { useAutofillSync, useMergedInputRef } from "./use-autofill-sync";

/**
 * Lot 111E — champ texte d'un formulaire d'authentification (identifiant de
 * connexion, adresse e-mail) dont l'état contrôlé est resynchronisé après un
 * remplissage automatique (voir `use-autofill-sync.ts`). Mêmes propriétés que
 * `Input` ; l'appelant fournit `name`, `id`, `type`, `inputMode` et
 * `autoComplete` (conventions : `src/lib/auth/autofill.ts`).
 */
export const AutofillInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  (props, ref) => {
    const [inner, setRef] = useMergedInputRef(ref);
    useAutofillSync(inner, props.value, props.onChange);
    return <Input ref={setRef} {...props} />;
  },
);

AutofillInput.displayName = "AutofillInput";
