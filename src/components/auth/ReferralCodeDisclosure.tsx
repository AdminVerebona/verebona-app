"use client";

/**
 * Code de parrainage REPLIÉ — lot 103B (capture iOS du 31/10 : champ déployé
 * qui allongeait le formulaire). Partagé par l'inscription e-mail et
 * l'inscription Google / Apple.
 *
 *   · aucun code : lien « J'ai un code de parrainage » ; le champ n'apparaît
 *     qu'au clic (focus placé dans le champ) ;
 *   · code reçu par un lien `?ref=` : « Code ABC123 appliqué » + « Modifier »,
 *     le code reste dans le parcours (erreurs, aller-retour Google / Apple) ;
 *   · jamais rendu pour un invité Premium Duo (l'appelant ne le monte pas).
 * L'attribution (`recordSignupReferral`) est inchangée.
 */
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { REFERRAL_TEXT } from '@/services/referral/referral-rules';
import { LegalLink } from '@/components/legal/LegalLink';

export const REFERRAL_DISCLOSURE_LABEL = 'J’ai un code de parrainage';

export function ReferralCodeDisclosure(props: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  /** Code arrivé par un lien `?ref=` : affiché déjà appliqué. */
  appliedFromLink?: boolean;
  termsHref?: string;
  /** Aide sous le champ (défaut : règle centrale `REFERRAL_TEXT.referredNotice`). */
  help?: string;
  disabled?: boolean;
}) {
  const { id, value, onChange, appliedFromLink = false, termsHref, help, disabled } = props;
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const showApplied = appliedFromLink && !!value && !open;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (showApplied) {
    return (
      <div className="text-sm text-[color:var(--text-muted)]" data-testid="referral-code-applied">
        <p>
          Code de parrainage <span className="font-mono font-semibold text-[color:var(--accent)]">{value}</span> appliqué.{' '}
          <button type="button" className="text-primary hover:underline" onClick={() => setOpen(true)} disabled={disabled}>
            Modifier
          </button>
        </p>
        {/* L'avantage revient au parrain, jamais au filleul (lot 102D). */}
        <p className="text-xs mt-0.5">{REFERRAL_TEXT.referredNotice}</p>
      </div>
    );
  }

  if (!open && !value) {
    return (
      <button
        type="button"
        className="text-sm text-primary hover:underline min-h-11 sm:min-h-0"
        aria-expanded={false}
        aria-controls={id}
        data-testid="referral-code-toggle"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        {REFERRAL_DISCLOSURE_LABEL}
      </button>
    );
  }

  return (
    <div className="space-y-2" data-testid="referral-code-field">
      <Label htmlFor={id}>Code de parrainage (facultatif)</Label>
      <Input
        id={id}
        ref={inputRef}
        type="text"
        placeholder="Ex. ABC123"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase().trim())}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="characters"
      />
      <p className="text-xs text-[color:var(--text-muted)]">
        {help ?? REFERRAL_TEXT.referredNotice}
        {termsHref && (
          <>
            {' '}
            <LegalLink href={termsHref} target="_blank" className="text-primary hover:underline">{REFERRAL_TEXT.termsLinkLabel}</LegalLink>
          </>
        )}
      </p>
    </div>
  );
}
