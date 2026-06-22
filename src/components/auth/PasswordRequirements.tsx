// src/components/auth/PasswordRequirements.tsx
"use client";

import { Check, X } from "lucide-react";
import { checkPassword } from "@/lib/auth/password-rules";

type PasswordRequirementsProps = {
  password: string;
  confirmPassword?: string;
  showConfirmRule?: boolean;
};

export function PasswordRequirements({
  password,
  confirmPassword,
  showConfirmRule = false,
}: PasswordRequirementsProps) {
  const result = checkPassword(password);
  const confirmOk =
    showConfirmRule && confirmPassword !== undefined
      ? password.length > 0 && password === confirmPassword
      : false;

  const baseClass = "flex items-center text-sm gap-2";
  const okClass = "text-emerald-600";
  const koClass = "text-gray-500";

  return (
    <div className="mt-2 space-y-1" aria-live="polite">
      <p className="text-xs text-gray-500 font-medium">
        Exigences du mot de passe :
      </p>

      <RuleItem ok={result.hasMinLength} label="Minimum 10 caractères" />
      <RuleItem ok={result.hasLetter} label="Au moins 1 lettre (A–Z, a–z)" />
      <RuleItem ok={result.hasDigit} label="Au moins 1 chiffre (0–9)" />
      <RuleItem
        ok={result.hasSpecial}
        label="Au moins 1 caractère spécial (!@#$%^&*()-_=+[]{};:,.?)"
      />
      <RuleItem ok={result.hasNoSpace} label="Aucun espace" />

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
