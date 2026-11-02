'use client';

/**
 * Demande expresse de démarrage immédiat (lot 102B) — case NON pré-cochée,
 * libellé factuel, renvoi au lien public des CGUV. Partagée par les trois
 * entrées de souscription (préparation du paiement, finalisation après
 * inscription, Mon compte › Offres), ordinateur et mobile.
 */
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { IMMEDIATE_START_HINT, IMMEDIATE_START_LABEL } from '@/lib/legal/immediate-start';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { LegalLink } from '@/components/legal/LegalLink';

export function ImmediateStartConsent({
  checked,
  onChange,
  disabled,
  id = 'immediate-start',
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const legal = useLegalLinks();
  return (
    <div className="flex items-start gap-3 text-left" data-testid="immediate-start-consent">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} className="mt-0.5" />
      <Label htmlFor={id} className="text-sm leading-relaxed font-normal cursor-pointer text-[color:var(--text-primary)]">
        {IMMEDIATE_START_LABEL}
        <span className="block text-xs text-[color:var(--text-muted)] mt-1">
          {IMMEDIATE_START_HINT}{' '}
          <LegalLink href={legal.cguv} target="_blank" className="underline">
            Lire les CGUV
          </LegalLink>
        </span>
      </Label>
    </div>
  );
}
