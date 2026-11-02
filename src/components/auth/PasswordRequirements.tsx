// src/components/auth/PasswordRequirements.tsx
"use client";

import { Check, X } from "lucide-react";
import { MIN_PASSWORD_LENGTH, checkPassword } from "@/lib/auth/password-rules";

type PasswordRequirementsProps = {
  password: string;
  confirmPassword?: string;
  showConfirmRule?: boolean;
  /**
   * Lot 103B (capture iOS du 31/10) : affichage PROGRESSIF à l'inscription —
   * une aide courte au chargement, puis les critères (seulement ceux qui
   * restent à remplir) au focus, pendant la saisie ou en cas d'erreur.
   * Les règles effectives (`password-rules`, client ET serveur) sont
   * strictement inchangées. Sans ce mode : liste complète (Mon compte).
   */
  progressive?: boolean;
  /** Mode progressif : critères détaillés visibles (focus, saisie, erreur). */
  expanded?: boolean;
  /** Identifiant de l'aide (pour `aria-describedby` du champ). */
  id?: string;
};

/** Aide courte (une ligne) — mêmes critères que `checkPassword`. */
export const PASSWORD_SHORT_HELP = `${MIN_PASSWORD_LENGTH} caractères minimum, avec une lettre, un chiffre et un caractère spécial, sans espace.`;

export function PasswordRequirements({
  password,
  confirmPassword,
  showConfirmRule = false,
  progressive = false,
  expanded = false,
  id,
}: PasswordRequirementsProps) {
  const result = checkPassword(password);
  const confirmOk =
    showConfirmRule && confirmPassword !== undefined
      ? password.length > 0 && password === confirmPassword
      : false;

  const baseClass = "flex items-center text-sm gap-2";
  const okClass = "text-[color:var(--text-success)]";
  const koClass = "text-[color:var(--text-muted)]";

  const rules: Array<{ key: string; ok: boolean; label: string }> = [
    { key: "len", ok: result.hasMinLength, label: `Minimum ${MIN_PASSWORD_LENGTH} caractères` },
    { key: "letter", ok: result.hasLetter, label: "Au moins 1 lettre (A–Z, a–z)" },
    { key: "digit", ok: result.hasDigit, label: "Au moins 1 chiffre (0–9)" },
    { key: "special", ok: result.hasSpecial, label: "Au moins 1 caractère spécial (!@#$%^&*()-_=+[]{};:,.?)" },
    { key: "space", ok: result.hasNoSpace, label: "Aucun espace" },
  ];

  if (progressive) {
    // Confirmation : signalée seulement une fois commencée (pas d'alerte à vide).
    const confirmStarted = showConfirmRule && !!confirmPassword;
    const pending = rules.filter((r) => !r.ok);
    return (
      <div className="mt-1.5 space-y-1" id={id} data-testid="password-requirements" data-mode={expanded ? "detailed" : "short"}>
        {!expanded ? (
          <p className="text-xs text-[color:var(--text-muted)]">{PASSWORD_SHORT_HELP}</p>
        ) : (
          <div aria-live="polite" className="space-y-1">
            {pending.length === 0 ? (
              <RuleItem ok label="Mot de passe conforme" />
            ) : (
              pending.map((r) => <RuleItem key={r.key} ok={false} label={r.label} />)
            )}
            {confirmStarted && (
              <RuleItem ok={confirmOk} label={confirmOk ? "La confirmation est identique" : "La confirmation n’est pas encore identique"} />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1" aria-live="polite">
      <p className="text-xs text-[color:var(--text-muted)] font-medium">
        Exigences du mot de passe :
      </p>

      {rules.map((r) => <RuleItem key={r.key} ok={r.ok} label={r.label} />)}

      {showConfirmRule && (
        <RuleItem ok={confirmOk} label="La confirmation est identique" />
      )}
    </div>
  );

  function RuleItem({ ok, label }: { ok: boolean; label: string }) {
    return (
      <div className={`${baseClass} ${ok ? okClass : koClass}`}>
        {ok ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : (
          <X className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{label}</span>
      </div>
    );
  }
}
