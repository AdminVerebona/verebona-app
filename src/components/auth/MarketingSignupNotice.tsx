'use client';

/**
 * Bloc « relances commerciales » du formulaire d'inscription — lot 102C
 * (ticket conformité, P2 « Prospection post-essai »). Inscription locale et
 * Google / Apple, desktop ET mobile (application comprise).
 *
 * Contenu fourni par le serveur (`/api/public/marketing/signup-notice`)
 * selon la base légale et le mécanisme choisis au BO : case d'acceptation
 * non pré-cochée, case d'opposition, ou mention seule ; lien public
 * « Politique de confidentialité ». Rien n'est affiché tant que le PO n'a
 * rien activé. Le choix (et l'empreinte du bloc affiché, preuve) est
 * transmis avec l'inscription : `{ marketing: { checked, noticeSha256 } }`.
 */
import { LegalLink } from '@/components/legal/LegalLink';
import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface Notice {
  mechanism: 'consent_checkbox' | 'opt_out_checkbox' | 'mention';
  information: string;
  checkboxLabel: string | null;
  help: string;
  privacyLabel: string;
  privacyUrl: string;
  sha256: string;
}

export interface MarketingChoiceValue {
  checked: boolean;
  noticeSha256: string;
}

export function MarketingSignupNotice({ onChange, disabled = false }: { onChange: (v: MarketingChoiceValue | null) => void; disabled?: boolean }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/marketing/signup-notice', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const n = (d?.notice ?? null) as Notice | null;
        setNotice(n);
        onChange(n ? { checked: false, noticeSha256: n.sha256 } : null);
      })
      .catch(() => { if (!cancelled) onChange(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lecture unique à l'ouverture du formulaire
  }, []);

  if (!notice) return null;

  const toggle = (v: boolean) => {
    setChecked(v);
    onChange({ checked: v, noticeSha256: notice.sha256 });
  };

  return (
    <div className="space-y-2 rounded-md border border-[color:var(--border-subtle)] p-3" data-testid="marketing-signup-notice">
      <p className="text-sm text-foreground">{notice.information}</p>
      {notice.checkboxLabel && (
        <div className="flex items-start gap-3">
          <Checkbox id="marketingChoice" checked={checked} onCheckedChange={(v) => toggle(v === true)} disabled={disabled} className="mt-1" />
          <Label htmlFor="marketingChoice" className="text-sm leading-relaxed cursor-pointer font-normal text-foreground">
            {notice.checkboxLabel}
          </Label>
        </div>
      )}
      <p className="text-xs text-[color:var(--text-muted)]">
        {notice.help}{' '}
        {/* Lot 108L : texte juridique — navigateur système dans l'app (open-external). */}
        <LegalLink href={notice.privacyUrl} target="_blank" className="underline">
          {notice.privacyLabel}
        </LegalLink>
      </p>
    </div>
  );
}
