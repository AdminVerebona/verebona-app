"use client"

/**
 * Rubrique « Informations complémentaires » de la fiche bien —
 * CDC Exports V12 §4, DEC-007, IC-GEN-001..009, PREP-INFOFORM.
 *
 * Sous-rubriques selon la famille (§4.2) : commerciales, locatives
 * (immobilier seulement), assurance, sinistre. Chaque saisie est enregistrée
 * automatiquement (700 ms après la dernière frappe, `additional-infos-autosave`)
 * avec un indicateur discret : « Enregistrement… », « Enregistré »,
 * « Échec de l'enregistrement ».
 *
 * Réutilisée telle quelle dans le tiroir de préparation d'un dossier
 * (`sections` restreint aux sous-rubriques du dossier, `variant="embedded"`) :
 * une valeur saisie pendant la préparation est la valeur de la fiche
 * (IC-GEN-003), il n'existe pas de copie temporaire (IC-GEN-009).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import {
  ADDITIONAL_INFO_SECTION_DESCRIPTIONS, ADDITIONAL_INFO_SECTION_LABELS, fieldsFor, interpretFieldInput,
  sectionsForCategory, toFieldInput,
  type AdditionalInfoFieldDef, type AdditionalInfoSectionKey, type AdditionalInfosData, type AdditionalInfosPatch,
} from '@/lib/assets/additional-infos';
import { createAutosaveQueue, type AutosaveQueue, type AutosaveState } from '@/lib/assets/additional-infos-autosave';
import { toExportFamily } from '@/services/exports/catalog';

interface AdditionalInfosResponse extends AdditionalInfosData {
  assetId: number;
  updatedAt: string | null;
  updatedBy: number | null;
  version: number;
}

interface Props {
  assetId: number;
  /** `assets.category` (IMMOBILIER, VEHICULE, OBJECT…). */
  category: string;
  readOnly?: boolean;
  /** Restreint aux sous-rubriques d'un dossier (tiroir de préparation). */
  sections?: readonly AdditionalInfoSectionKey[];
  variant?: 'card' | 'embedded';
  /** Ouvert au premier affichage. */
  defaultOpen?: boolean;
}

const NONE = '__none__';

function SaveIndicator({ state, onRetry }: { state: AutosaveState; onRetry: () => void }) {
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

export function AssetAdditionalInfosSection({
  assetId, category, readOnly = false, sections, variant = 'card', defaultOpen = false,
}: Props) {
  const family = toExportFamily(category);
  const visible = useMemo(() => {
    const bySection = sectionsForCategory(category);
    return sections ? bySection.filter((s) => sections.includes(s)) : bySection;
  }, [category, sections]);

  const [open, setOpen] = useState(defaultOpen || variant === 'embedded');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /** Texte des champs, clé `section.champ`. */
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<AutosaveState>('idle');
  const queueRef = useRef<AutosaveQueue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await apiClient.get<AdditionalInfosResponse>(`/api/assets/${assetId}/additional-infos`);
      const next: Record<string, string> = {};
      for (const s of visible) {
        for (const def of fieldsFor(s, family)) next[`${s}.${def.key}`] = toFieldInput(def, data[s]?.[def.key]);
      }
      setInputs(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [assetId, visible, family]);

  useEffect(() => { void load(); }, [load]);

  // File d'enregistrement : une par bien.
  useEffect(() => {
    const queue = createAutosaveQueue({
      save: async (patch: AdditionalInfosPatch) => {
        try {
          await apiClient.patch(`/api/assets/${assetId}/additional-infos`, patch);
        } catch (err) {
          // Refus de validation serveur : message affiché sous le champ.
          const fields = (err as { details?: { fields?: Array<{ path: string; message: string }> } })?.details?.fields;
          if (Array.isArray(fields) && fields.length > 0) {
            setErrors((prev) => ({ ...prev, ...Object.fromEntries(fields.map((f) => [f.path, f.message])) }));
            // Valeurs refusées retirées de la file : elles ne repartiraient qu'en échec.
            for (const f of fields) {
              const [s, k] = f.path.split('.');
              if (s && k) queue.discard(s as AdditionalInfoSectionKey, k);
            }
          }
          throw err;
        }
      },
      onStateChange: (s) => setSaveState(s),
    });
    queueRef.current = queue;
    const flushOnHide = () => { if (document.visibilityState === 'hidden') void queue.flush(); };
    document.addEventListener('visibilitychange', flushOnHide);
    return () => {
      document.removeEventListener('visibilitychange', flushOnHide);
      // Démontage : ce qui attend part tout de suite, rien n'est perdu.
      if (queue.hasPending()) void queue.flush();
      queue.dispose();
    };
  }, [assetId]);

  const onChange = useCallback((section: AdditionalInfoSectionKey, def: AdditionalInfoFieldDef, raw: string) => {
    const path = `${section}.${def.key}`;
    setInputs((prev) => ({ ...prev, [path]: raw }));
    const r = interpretFieldInput(def, raw);
    const queue = queueRef.current;
    if (!queue) return;
    if (r.kind === 'invalid') {
      setErrors((prev) => ({ ...prev, [path]: r.message }));
      queue.discard(section, def.key);
      return;
    }
    setErrors((prev) => {
      if (!(path in prev)) return prev;
      const { [path]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    queue.set(section, def.key, r.kind === 'clear' ? null : r.value);
  }, []);

  /** Montants et surfaces remis en forme française en quittant le champ. */
  const onBlur = useCallback((section: AdditionalInfoSectionKey, def: AdditionalInfoFieldDef) => {
    if (def.type !== 'money' && def.type !== 'decimal') return;
    const path = `${section}.${def.key}`;
    setInputs((prev) => {
      const r = interpretFieldInput(def, prev[path] ?? '');
      if (r.kind !== 'set') return prev;
      return { ...prev, [path]: toFieldInput(def, r.value) };
    });
  }, []);

  if (visible.length === 0) return null;

  const filled = Object.values(inputs).filter((v) => v.trim() !== '').length;

  const body = loading ? (
    <div className="space-y-2 p-4">
      {[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  ) : loadError ? (
    <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
      <AlertCircle className="w-4 h-4 text-red-400" />
      Les informations complémentaires n&apos;ont pas pu être chargées.
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
    </div>
  ) : (
    <div className={variant === 'embedded' ? 'space-y-5' : 'p-4 space-y-6'}>
      {visible.map((section) => (
        <fieldset key={section} className="space-y-3" disabled={readOnly}>
          <div>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {ADDITIONAL_INFO_SECTION_LABELS[section]}
            </legend>
            <p className="text-xs text-muted-foreground/80 mt-0.5">{ADDITIONAL_INFO_SECTION_DESCRIPTIONS[section]}</p>
          </div>
          <div className={`grid grid-cols-1 gap-4 ${variant === 'embedded' ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
            {fieldsFor(section, family).map((def) => {
              const path = `${section}.${def.key}`;
              const inputId = `ai-${assetId}-${section}-${def.key}`;
              const error = errors[path];
              const value = inputs[path] ?? '';
              const wide = def.type === 'textarea';
              return (
                <div key={path} className={`space-y-1.5 ${wide && variant !== 'embedded' ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
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
                      onChange={(e) => onChange(section, def, e.target.value)}
                      className="text-sm"
                    />
                  ) : def.type === 'enum' ? (
                    <Select
                      value={value || NONE}
                      disabled={readOnly}
                      onValueChange={(v) => onChange(section, def, v === NONE ? '' : v)}
                    >
                      <SelectTrigger id={inputId} className="w-full text-sm" aria-invalid={!!error}>
                        <SelectValue placeholder="Non renseigné" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Non renseigné</SelectItem>
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
                        onChange={(e) => onChange(section, def, e.target.value)}
                        onBlur={() => onBlur(section, def)}
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
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );

  if (variant === 'embedded') {
    return (
      <div className="space-y-3" id={`asset-additional-infos-${assetId}`}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Informations complémentaires</p>
          <SaveIndicator state={saveState} onRetry={() => void queueRef.current?.retry()} />
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Enregistrées dans la fiche du bien et reprises dans vos prochains dossiers. Les champs vides n&apos;apparaissent pas dans le PDF.
        </p>
        {body}
      </div>
    );
  }

  return (
    <div id="asset-section-additional_infos" className="border border-border rounded-lg overflow-hidden">
      <div className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-muted/30">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 min-w-0 text-left flex-1"
          aria-expanded={open}
        >
          <span className="font-medium text-sm">Informations complémentaires</span>
          {!loading && filled > 0 && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-1.5 py-0.5 shrink-0">
              {filled} renseignée{filled > 1 ? 's' : ''}
            </span>
          )}
        </button>
        <div className="flex items-center gap-3 shrink-0">
          <SaveIndicator state={saveState} onRetry={() => void queueRef.current?.retry()} />
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Réduire' : 'Développer'}>
            {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
        </div>
      </div>
      {open && (
        <>
          <p className="px-4 pt-3 text-xs text-muted-foreground leading-snug">
            Prix, conditions, loyer, objectif d&apos;assurance, sinistre : saisis une fois ici, ils sont repris dans vos dossiers prêts à l&apos;emploi.
            {!readOnly && ' Enregistrement automatique.'}
          </p>
          {body}
        </>
      )}
    </div>
  );
}
