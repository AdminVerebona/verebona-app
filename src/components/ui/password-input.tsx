"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "../../lib/utils";
import { Input } from "./input";
import { useAutofillSync, useMergedInputRef } from "./use-autofill-sync";

type PasswordInputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Champ de mot de passe avec bouton « Afficher / Masquer ».
 *
 * Lot 111E (remplissage automatique) : l'appelant fournit `name`, `id` et
 * `autoComplete` (« current-password » ou « new-password », exigé par le test
 * d'architecture) ; le champ
 *  - resynchronise l'état contrôlé quand un gestionnaire de mots de passe le
 *    remplit sans événement vu par React (`useAutofillSync`) ;
 *  - redevient masqué (type="password") à l'envoi du formulaire, pour que le
 *    système propose d'enregistrer / mettre à jour l'identifiant même si
 *    l'utilisateur l'avait affiché.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const [inner, setRef] = useMergedInputRef(ref);
    useAutofillSync(inner, props.value, props.onChange);

    React.useEffect(() => {
      const form = inner.current?.form;
      if (!form) return;
      const hide = () => setVisible(false);
      form.addEventListener("submit", hide, true);
      return () => form.removeEventListener("submit", hide, true);
    }, [inner]);

    const toggleVisibility = () => {
      setVisible((prev) => !prev);
    };

    return (
      <div className="relative">
        <Input
          ref={setRef}
          type={visible ? "text" : "password"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn("pr-10", className)}
          {...props}
        />

        <button
          type="button"
          onClick={toggleVisibility}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={visible ? "Masquer le mot de passe" : "Afficher le mot de passe"}
          aria-pressed={visible}
          aria-controls={props.id}
          disabled={props.disabled}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  }
);

PasswordInput.displayName = "PasswordInput";
