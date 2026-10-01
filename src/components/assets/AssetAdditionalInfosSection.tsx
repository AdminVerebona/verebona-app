"use client"

/**
 * Rubrique « Informations complémentaires » de la fiche bien —
 * CDC Exports V12 §4, DEC-007, IC-GEN-001..009, PREP-INFOFORM.
 *
 * Sous-rubriques selon la famille (§4.2) : commerciales, locatives
 * (immobilier seulement), assurance, sinistre, valeur et charges. Chaque
 * saisie est enregistrée automatiquement (700 ms après la dernière frappe,
 * `additional-infos-autosave`) avec un indicateur discret : « Enregistrement… »,
 * « Enregistré », « Échec de l'enregistrement ».
 *
 * Listes structurées (dommages, actions, échanges, points forts, protections,
 * éléments à assurer, charges) : lignes répétables (ajout, retrait,
 * réordonnancement), envoyées EN BLOC par la même file, avec la version
 * connue. Un 409 (liste modifiée dans un autre onglet ou par le co-titulaire)
 * est résolu par `rebaseAfterConflict` : rejoué si la liste serveur n'a pas
 * bougé, sinon la liste serveur est affichée et un message l'explique.
 * Sélecteurs de pièces, photos et événement sinistre : `?include=references`.
 *
 * Réutilisée telle quelle dans le tiroir de préparation d'un dossier
 * (`sections` restreint aux sous-rubriques du dossier, `variant="embedded"`) :
 * une valeur saisie pendant la préparation est la valeur de la fiche
 * (IC-GEN-003), il n'existe pas de copie temporaire (IC-GEN-009).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Check, Loader2, AlertCircle, RefreshCw, Plus, Sparkles, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import {
  ADDITIONAL_INFO_FIELDS, ADDITIONAL_INFO_SECTION_DESCRIPTIONS, ADDITIONAL_INFO_SECTION_LABELS, fieldsFor, findField, interpretFieldInput,
  listFormState, listValue, newListItemId, sameList, sectionsForCategory, suggestionOrigin, toFieldInput,
  type AdditionalInfoFieldDef, type AdditionalInfoReferencesDto, type AdditionalInfoSectionKey, type AdditionalInfosData,
  type AdditionalInfosPatch, type ListItem,
} from '@/lib/assets/additional-infos';
import {
  createAutosaveQueue, patchListPaths, rebaseAfterConflict, withRequeue, type AutosaveQueue, type AutosaveState,
} from '@/lib/assets/additional-infos-autosave';
import { toExportFamily } from '@/services/exports/catalog';
import { AdditionalInfosListField } from './additional-infos/AdditionalInfosListField';

interface AdditionalInfosResponse extends AdditionalInfosData {
  assetId: number;
  updatedAt: string | null;
  updatedBy: number | null;
  version: number;
  references?: AdditionalInfoReferencesDto;
}

const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
/** Champs saisis ligne à ligne (listes) ou par sélecteur dédié, hors de la grille des champs simples. */
const isGridField = (def: AdditionalInfoFieldDef) => def.type !== 'list' && def.type !== 'eventRef';

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
  /**
   * État de l'enregistrement automatique (IC-GEN-004), pour l'écran de
   * préparation d'un dossier (MSG-PREP-006 : pas de génération tant qu'un
   * enregistrement est en cours ou en échec). Facultatif.
   */
  onSaveStateChange?: (state: AutosaveState) => void;
  /**
   * Sous-rubriques dont des champs viennent d'être ENREGISTRÉS (écriture
   * réussie) — ex. recomposer les annonces de vente quand `commercial`
   * change (VENTE-RULE-002). Facultatif.
   */
  onSectionsSaved?: (sections: AdditionalInfoSectionKey[]) => void;
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
  assetId, category, readOnly = false, sections, variant = 'card', defaultOpen = false, onSaveStateChange, onSectionsSaved,
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
  // Rappel lu par la file sans la recréer à chaque rendu.
  const onSaveStateRef = useRef(onSaveStateChange);
  onSaveStateRef.current = onSaveStateChange;
  const onSectionsSavedRef = useRef(onSectionsSaved);
  onSectionsSavedRef.current = onSectionsSaved;
  /** Listes affichées (brouillons compris), clé `section.champ`. */
  const [lists, setLists] = useState<Record<string, ListItem[]>>({});
  /** Liste dont une cellule est illisible (montant…) : elle ne part pas. */
  const [listLocalErrors, setListLocalErrors] = useState<Record<string, boolean>>({});
  const [references, setReferences] = useState<AdditionalInfoReferencesDto | null>(null);
  /** Message après un conflit (liste modifiée ailleurs). */
  const [notice, setNotice] = useState<string | null>(null);
  /** Version serveur connue (contrôle optimiste des listes). */
  const versionRef = useRef(0);
  /** Listes telles que le serveur les a rendues pour la dernière fois (base d'un rejeu après 409). */
  const baseListsRef = useRef<Record<string, ListItem[]>>({});
  const needsReferences = useMemo(
    () => visible.some((sec) => fieldsFor(sec, family).some((d) => d.type === 'list' || d.type === 'eventRef')),
    [visible, family],
  );

  /** Mémorise l'état serveur (version, listes) sans toucher à la saisie en cours. */
  const adoptServer = useCallback((data: AdditionalInfosData & { version: number }) => {
    versionRef.current = data.version ?? 0;
    const base: Record<string, ListItem[]> = {};
    for (const def of ADDITIONAL_INFO_FIELDS) {
      if (def.type === 'list') base[`${def.section}.${def.key}`] = listValue(data[def.section], def.key);
    }
    baseListsRef.current = base;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await apiClient.get<AdditionalInfosResponse>(`/api/assets/${assetId}/additional-infos`);
      const next: Record<string, string> = {};
      const nextLists: Record<string, ListItem[]> = {};
      for (const s of visible) {
        for (const def of fieldsFor(s, family)) {
          if (def.type === 'list') nextLists[`${s}.${def.key}`] = listValue(data[s], def.key);
          else next[`${s}.${def.key}`] = toFieldInput(def, data[s]?.[def.key]);
        }
      }
      setInputs(next);
      setLists(nextLists);
      setListLocalErrors({});
      adoptServer(data);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [assetId, visible, family, adoptServer]);

  useEffect(() => { void load(); }, [load]);

  // Éléments citables (pièces, photos, sinistres de l'agenda, suggestions) : lus
  // à l'ouverture de la rubrique seulement — la fiche bien ne paie pas cette
  // lecture tant que la rubrique reste repliée.
  const referencesRequested = useRef(false);
  useEffect(() => {
    if (!open || !needsReferences || referencesRequested.current) return;
    referencesRequested.current = true;
    apiClient.get<AdditionalInfosResponse>(`/api/assets/${assetId}/additional-infos?include=references`)
      .then((data) => setReferences(data.references ?? null))
      .catch(() => { referencesRequested.current = false; });
  }, [open, needsReferences, assetId]);

  // File d'enregistrement : une par bien.
  useEffect(() => {
    const url = `/api/assets/${assetId}/additional-infos`;
    /** Une liste part toujours avec la version connue (contrôle optimiste, 409 sinon). */
    const send = (patch: AdditionalInfosPatch) => apiClient.patch<AdditionalInfosResponse>(
      url, patchListPaths(patch).length ? { ...patch, version: versionRef.current } : patch,
    );
    const queue = createAutosaveQueue({
      save: async (patch: AdditionalInfosPatch) => {
        try {
          try {
            adoptServer(await send(patch));
          } catch (err) {
            const e = err as { status?: number; details?: { current?: AdditionalInfosResponse } };
            const current = e?.status === 409 ? e.details?.current : undefined;
            if (!current) throw err;
            // Conflit : rejouer ce qui peut l'être, adopter les listes modifiées ailleurs.
            const { retry, conflicts } = rebaseAfterConflict(patch, baseListsRef.current, current);
            adoptServer(current);
            if (conflicts.length) {
              // Une saisie plus récente de ces listes, encore en file, partirait sur la nouvelle version
              // et écraserait la modification faite ailleurs : elle est abandonnée avec le reste.
              // Bloquées : elles ne reviendront pas en file, même si la suite échoue,
              // tant que l'utilisateur ne les a pas modifiées à nouveau.
              for (const path of conflicts) {
                const [sec, key] = path.split('.') as [AdditionalInfoSectionKey, string];
                queue.block(sec, key);
              }
              setLists((prev) => {
                const next = { ...prev };
                for (const path of conflicts) {
                  const [sec, key] = path.split('.') as [AdditionalInfoSectionKey, string];
                  next[path] = listValue(current[sec], key);
                }
                return next;
              });
              const labels = conflicts.map((p) => {
                const [sec, key] = p.split('.') as [AdditionalInfoSectionKey, string];
                return `« ${findField(sec, key)?.label ?? key} »`;
              });
              setNotice(`${labels.join(', ')} ${conflicts.length > 1 ? 'ont été modifiées' : 'a été modifiée'} entre-temps (autre onglet ou co-titulaire) : la version la plus récente est affichée, votre dernière modification de cette liste n'a pas été enregistrée.`);
            }
            if (Object.keys(retry).length) {
              try {
                adoptServer(await send(retry));
              } catch (e2) {
                // Seul le correctif rejoué revient en file, jamais le lot d'origine (listes périmées).
                throw withRequeue(e2, retry);
              }
            }
          }
        } catch (err) {
          // Refus de validation serveur : message affiché sous le champ (ou sous la liste).
          const fields = (err as { details?: { fields?: Array<{ path: string; message: string }> } })?.details?.fields;
          if (Array.isArray(fields) && fields.length > 0) {
            setErrors((prev) => {
              const next = { ...prev };
              for (const f of fields) {
                const m = /^(\w+)\.(\w+)(?:\[(\d+)\])?/.exec(f.path);
                if (!m) continue;
                next[`${m[1]}.${m[2]}`] = m[3] !== undefined ? `Ligne ${Number(m[3]) + 1} : ${f.message}` : f.message;
              }
              return next;
            });
            // Valeurs refusées retirées de la file : elles ne repartiraient qu'en échec.
            for (const f of fields) {
              const m = /^(\w+)\.(\w+)/.exec(f.path);
              if (m) queue.discard(m[1] as AdditionalInfoSectionKey, m[2]);
            }
          }
          throw err;
        }
        // Écriture réussie : sous-rubriques effectivement envoyées.
        const envoyees = Object.keys(patch).filter((k) => k !== 'version') as AdditionalInfoSectionKey[];
        if (envoyees.length) onSectionsSavedRef.current?.(envoyees);
      },
      onStateChange: (s) => { setSaveState(s); onSaveStateRef.current?.(s); },
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
  }, [assetId, adoptServer]);

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

  /** Nouvelle liste saisie : envoyée en bloc si elle est valide (brouillons retirés) et différente du serveur. */
  const onListChange = useCallback((section: AdditionalInfoSectionKey, def: AdditionalInfoFieldDef, items: ListItem[], opts?: { localError?: boolean }) => {
    const path = `${section}.${def.key}`;
    setLists((prev) => ({ ...prev, [path]: items }));
    setListLocalErrors((prev) => ({ ...prev, [path]: !!opts?.localError }));
    setErrors((prev) => {
      if (!(path in prev)) return prev;
      const { [path]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
    setNotice(null);
    const queue = queueRef.current;
    if (!queue) return;
    const state = listFormState(def, items);
    if (opts?.localError || !state.payload) { queue.discard(section, def.key); return; }
    if (sameList(state.payload, baseListsRef.current[path])) { queue.discard(section, def.key); return; }
    queue.set(section, def.key, state.payload.length ? state.payload : null);
  }, []);

  /** Lien vers le sinistre de l'agenda : sa date devient la date du sinistre si elle n'est pas saisie. */
  const onClaimEventChange = useCallback((def: AdditionalInfoFieldDef, key: string) => {
    onChange('claim', def, key);
    const ev = references?.claimEvents.find((e) => e.key === key);
    const dateDef = findField('claim', 'occurredOn');
    if (ev?.date && dateDef && !(inputs['claim.occurredOn'] ?? '').trim()) onChange('claim', dateDef, ev.date.slice(0, 10));
  }, [onChange, references, inputs]);

  if (visible.length === 0) return null;

  const filled = Object.values(inputs).filter((v) => v.trim() !== '').length
    + Object.values(lists).filter((l) => l.length > 0).length;

  const renderClaimEvent = (def: AdditionalInfoFieldDef) => {
    const path = `claim.${def.key}`;
    const inputId = `ai-${assetId}-claim-${def.key}`;
    const value = inputs[path] ?? '';
    const events = references?.claimEvents ?? [];
    const known = !value || events.some((e) => e.key === value);
    return (
      <div key={path} className="space-y-1.5">
        <Label htmlFor={inputId} className="text-xs text-muted-foreground font-medium">
          {def.label}<span className="ml-1.5 text-[10px] font-semibold text-primary/80">Recommandé</span>
        </Label>
        <Select value={value || NONE} disabled={readOnly || !references} onValueChange={(v) => onClaimEventChange(def, v === NONE ? '' : v)}>
          <SelectTrigger id={inputId} className="w-full text-sm" aria-invalid={!!errors[path]}>
            <SelectValue placeholder={references ? 'Aucun (saisie temporaire)' : 'Chargement…'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Aucun (saisie temporaire)</SelectItem>
            {!known && <SelectItem value={value}>Événement supprimé ou annulé</SelectItem>}
            {events.map((e) => (
              <SelectItem key={e.key} value={e.key}>{[frDate(e.date), e.title].filter(Boolean).join(' · ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors[path] ? <p className="text-[11px] text-red-400">{errors[path]}</p> : (
          <p className="text-[11px] text-muted-foreground/80 leading-snug">
            {references && events.length === 0
              ? "Aucun sinistre dans l'agenda de ce bien : les champs ci-dessous servent de saisie temporaire pour le dossier."
              : def.help}
          </p>
        )}
      </div>
    );
  };

  const renderHighlightSuggestions = (section: AdditionalInfoSectionKey, def: AdditionalInfoFieldDef) => {
    const items = lists[`${section}.${def.key}`] ?? [];
    const taken = new Set(items.map((i) => i.origin).filter(Boolean));
    const pending = (references?.highlightSuggestions ?? []).filter((h) => !taken.has(suggestionOrigin(h.key)));
    if (readOnly || !pending.length) return null;
    const full = items.length >= (def.list?.maxItems ?? 0);
    return (
      <div className="rounded-lg border border-border/70 bg-primary/[0.04] p-3 space-y-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-primary/80" />Suggestions tirées de vos données
        </p>
        <ul className="space-y-1.5">
          {pending.map((h) => (
            <li key={h.key} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{h.title}</p>
                <p className="text-[11px] text-muted-foreground leading-snug">{h.text}</p>
              </div>
              <button
                type="button"
                disabled={full}
                onClick={() => onListChange(section, def, [...items, { id: newListItemId(), title: h.title, text: h.text, origin: suggestionOrigin(h.key) }])}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] hover:border-primary/60 hover:text-foreground text-muted-foreground disabled:opacity-40 disabled:pointer-events-none"
                aria-label={`Ajouter le point fort « ${h.title} »`}
              >
                <Plus className="w-3 h-3" />Ajouter
              </button>
            </li>
          ))}
        </ul>
        {full && <p className="text-[11px] text-muted-foreground">Retirez un point fort pour en ajouter un autre.</p>}
      </div>
    );
  };

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
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="underline underline-offset-2 hover:text-foreground">Compris</button>
        </div>
      )}
      {visible.map((section) => (
        <fieldset key={section} className="space-y-3" disabled={readOnly}>
          <div>
            <legend className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {ADDITIONAL_INFO_SECTION_LABELS[section]}
            </legend>
            <p className="text-xs text-muted-foreground/80 mt-0.5">{ADDITIONAL_INFO_SECTION_DESCRIPTIONS[section]}</p>
          </div>
          {fieldsFor(section, family).filter((d) => d.type === 'eventRef').map((def) => renderClaimEvent(def))}
          <div className={`grid grid-cols-1 gap-4 ${variant === 'embedded' ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
            {fieldsFor(section, family).filter(isGridField).map((def) => {
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
          {fieldsFor(section, family).filter((d) => d.type === 'list').map((def) => {
            const path = `${section}.${def.key}`;
            const items = lists[path] ?? [];
            const state = listFormState(def, items);
            return (
              <div key={path} className="pt-1">
                <AdditionalInfosListField
                  def={def}
                  items={items}
                  onChange={(next, opts) => onListChange(section, def, next, opts)}
                  rowErrors={state.rowErrors}
                  listError={state.listError ?? errors[path] ?? (listLocalErrors[path] ? 'Corrigez la saisie signalée : la liste sera enregistrée ensuite.' : null)}
                  references={references}
                  readOnly={readOnly}
                  idPrefix={`ai-${assetId}-${section}-${def.key}`}
                  compact={variant === 'embedded'}
                  footer={def.key === 'highlights' ? renderHighlightSuggestions(section, def) : undefined}
                />
              </div>
            );
          })}
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
            Prix, points forts, loyer, protections, sinistre, valeur et charges : saisis une fois ici, ils sont repris dans vos dossiers prêts à l&apos;emploi.
            {!readOnly && ' Enregistrement automatique.'}
          </p>
          {body}
        </>
      )}
    </div>
  );
}
