"use client"

/**
 * Champ simple d'une sous-rubrique (texte, zone de texte, liste déroulante,
 * date, montant) — extrait du tiroir « Préparation des dossiers » au lot 44
 * pour être partagé avec la rubrique « Sinistres » de la fiche (mêmes
 * composants, mêmes jetons, desktop et mobile).
 */
import { Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AdditionalInfoFieldDef } from '@/lib/assets/additional-infos';
import type { AutosaveState } from '@/lib/assets/additional-infos-autosave';

export const NONE_VALUE = '__none__';

interface Props {
  def: AdditionalInfoFieldDef;
  inputId: string;
  value: string;
  error?: string | null;
  readOnly?: boolean;
  /** Grille large (fiche) : une zone de texte occupe toute la ligne. */
  wide?: boolean;
  onChange: (raw: string) => void;
  onBlur?: () => void;
}

export function AdditionalInfoFieldInput({ def, inputId, value, error, readOnly = false, wide = false, onChange, onBlur }: Props) {
  return (
    <div className={`space-y-1.5 ${def.type === 'textarea' && wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <Label htmlFor={inputId} className="text-xs text-muted-foreground font-medium">
        {def.label}
        {def.recommended && <span className="ml-1.5 text-[10px] font-semibold text-primary/80">Recommandé</span>}
      </Label>
      {def.type === 'textarea' ? (
        <Textarea
          id={inputId}
          value={value}
          placeholder={def.placeholder}
          rows={3}
          aria-invalid={!!error}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className="text-sm"
        />
      ) : def.type === 'enum' ? (
        <Select value={value || NONE_VALUE} disabled={readOnly} onValueChange={(v) => onChange(v === NONE_VALUE ? '' : v)}>
          <SelectTrigger id={inputId} className="w-full text-sm" aria-invalid={!!error}>
            <SelectValue placeholder="Non renseigné" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>Non renseigné</SelectItem>
            {(def.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : (
        <div className="relative">
          <Input
            id={inputId}
            type={def.type === 'date' ? 'date' : 'text'}
            inputMode={def.type === 'money' || def.type === 'decimal' ? 'decimal' : def.type === 'year' ? 'numeric' : undefined}
            value={value}
            placeholder={def.placeholder ?? (def.type === 'money' ? '0' : undefined)}
            aria-invalid={!!error}
            readOnly={readOnly}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            className={def.type === 'money' ? 'pr-8' : undefined}
          />
          {def.type === 'money' && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>
          )}
        </div>
      )}
      {error ? (
        <p className="text-[11px] text-red-400">{error}</p>
      ) : def.help ? (
        <p className="text-[11px] text-muted-foreground/80 leading-snug">{def.help}</p>
      ) : null}
    </div>
  );
}

/** Indicateur discret de l'enregistrement automatique (IC-GEN-004). */
export function SaveIndicator({ state, onRetry }: { state: AutosaveState; onRetry: () => void }) {
  if (state === 'saving' || state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" aria-live="polite">
        <Loader2 className="w-3 h-3 animate-spin" />Enregistrement…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400" aria-live="polite">
        <Check className="w-3 h-3" />Enregistré
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-red-400" aria-live="assertive">
        <AlertCircle className="w-3 h-3" />Échec de l&apos;enregistrement
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground">
          <RefreshCw className="w-3 h-3" />Réessayer
        </button>
      </span>
    );
  }
  return null;
}
