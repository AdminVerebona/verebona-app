'use client';

/**
 * Lot 111O — bloc de consentement aux CGUV des formulaires d'inscription
 * (classique et Google / Apple), une seule mise en page desktop + mobile :
 *
 *   [ ] J'ai lu et j'accepte les CGUV (…) de Verebona, incluant la
 *       Politique de confidentialité.
 *       Version 2026-10-30-v1 · Lire les CGUV · Confidentialité
 *
 * La version et les liens sont SOUS le libellé, alignés sur son texte (plus
 * de colonne à droite : le libellé n'est plus un `Label` en `flex`). En état
 * de blocage : case désactivée, ni version ni « Lire les CGUV » (aucune
 * version non vérifiée n'est présentée), « Confidentialité » reste à sa
 * place, puis l'encart d'attente avec « Réessayer ».
 */
import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { LegalLink } from '@/components/legal/LegalLink';
import { CguvPublicTextNotice } from '@/components/legal/CguvPublicTextNotice';
import type { CurrentCguvView } from '@/components/legal/useCurrentCguv';

export const CGUV_CONSENT_LABEL =
  'J’ai lu et j’accepte les CGUV (Conditions générales d’utilisation et de vente) de Verebona, incluant la Politique de confidentialité.';

export interface CguvConsentProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  cguv: CurrentCguvView | null;
  /** Lien CGUV générique (version non encore chargée). */
  fallbackCguvHref: string;
  /** Lien « Confidentialité » (useLegalLinks) si le serveur n'en a pas donné. */
  fallbackPrivacyHref: string;
  disabled?: boolean;
  checking?: boolean;
  onRetry?: () => void;
  error?: string | null;
  readTestId?: string;
  size?: 'base' | 'sm';
}

export function CguvConsent({
  id, checked, onCheckedChange, cguv, fallbackCguvHref, fallbackPrivacyHref, disabled, checking, onRetry, error, readTestId = 'signup-read-cguv', size = 'base',
}: CguvConsentProps) {
  const metaId = useId();
  const blocked = cguv?.available === false;
  const privacyHref = cguv?.confidentialite ?? fallbackPrivacyHref;
  const linkClass = 'inline-flex items-center min-h-8 font-medium text-primary underline-offset-2 hover:underline';
  return (
    <div className="space-y-3" data-testid="cguv-consent" data-state={blocked ? 'blocked' : cguv ? 'ready' : 'loading'}>
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked && !blocked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          disabled={disabled || blocked}
          aria-describedby={metaId}
          aria-invalid={error ? true : undefined}
          className="mt-1 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <label
            htmlFor={id}
            className={`block ${size === 'sm' ? 'text-sm' : 'text-sm sm:text-base'} leading-relaxed font-normal text-foreground ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          >
            {CGUV_CONSENT_LABEL}
          </label>
          <p id={metaId} className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-[color:var(--text-muted)]">
            {cguv && !blocked && (
              <>
                <span data-testid="cguv-consent-version">Version {cguv.versionCode}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {!blocked && (
              <>
                {/* Version EXACTE proposée à cet instant (§8.1), sur le site public de
                    l'environnement (lot 108L : jamais app.* ni /cgvu, jamais une autre version). */}
                <LegalLink href={cguv ? cguv.permalink : fallbackCguvHref} target="_blank" className={linkClass} data-testid={readTestId}>
                  Lire les CGUV
                </LegalLink>
                <span aria-hidden="true">·</span>
              </>
            )}
            <LegalLink href={privacyHref} target="_blank" className={linkClass} data-testid="cguv-consent-privacy">
              Confidentialité
            </LegalLink>
          </p>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {blocked && <CguvPublicTextNotice onRetry={onRetry} checking={checking} />}
    </div>
  );
}
