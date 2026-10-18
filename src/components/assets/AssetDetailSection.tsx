"use client"

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { YearPicker } from '@/components/ui/year-picker';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberInput } from '@/components/ui/number-input';
import { formatNumberForInput, parseNumberInput, MONEY_INPUT, QUANTITY_INPUT, type NumberParseOptions } from '@/lib/number-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChevronDown, ChevronUp, Pencil, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { changedDetailFields, todayParis } from '@/lib/asset-detail-rules';
import { toast } from 'sonner';
import { useWriteGuard } from '@/contexts/WriteGuardContext';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  readonly?: boolean;
  /** Date : échéance à venir — les jours passés ne sont pas proposés (le serveur les refuse aussi). */
  futureOnly?: boolean;
  /** Retourne true quand le champ est sans objet (affiche N/A, désactivé en édition, envoyé null) */
  notApplicableWhen?: (data: Record<string, unknown>) => boolean;
  /**
   * Champ affiché seulement dans cette situation (lecture et édition) — ex.
   * vente réalisée d'un bien vendu (lot 43, décision PO Q5). Absent : toujours.
   */
  visibleWhen?: (data: Record<string, unknown>) => boolean;
  /**
   * Provenance affichée à côté du libellé (ex. « Calculée (début + durée) »,
   * lot 49A) ; masquée en édition dès que la valeur est modifiée.
   */
  badge?: (data: Record<string, unknown>) => string | null;
}

/** Pastille de provenance (jetons et style des pastilles existantes de la fiche). */
function FieldBadge({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span data-field-badge className="inline-flex items-center ml-1 text-[9px] font-semibold text-[color:var(--accent)] bg-[color:var(--accent-soft)] rounded px-1.5 py-0.5">
      {text}
    </span>
  );
}

/** Champs visibles pour ces données (`visibleWhen`). */
export function visibleFields(fields: FieldDef[], data: Record<string, unknown>): FieldDef[] {
  return fields.filter((f) => !f.visibleWhen || f.visibleWhen(data));
}

interface Props {
  title: string;
  sectionKey: string;
  assetId: number;
  data: Record<string, unknown>;
  fields: FieldDef[];
  onRefresh: () => void;
  defaultOpen?: boolean;
  mobileOnly?: boolean;
  forceOpen?: boolean;
  forceEdit?: boolean;
  readOnly?: boolean;
  /** Field key to highlight (ring) in read mode */
  highlightField?: string;
  /** Extra actions rendered next to the Modifier button in read mode */
  headerActions?: React.ReactNode;
  /** Coherence alerts for fields in this section */
  coherenceAlerts?: { field: string; issue: string; suggestedValue: string | null; sourceDocument: string }[];
  /** Called when user dismisses a coherence alert */
  onDismissAlert?: (field: string) => void;
  /** Called when user accepts a coherence alert suggestion — applies the value */
  onApplyAlert?: (field: string, suggestedValue: string) => void;
}

/** Champ numérique saisi au clavier (les années passent par le sélecteur d'année). */
function isTypedNumberField(field: FieldDef): boolean {
  return field.type === 'number' && !field.options && !field.key.toLowerCase().includes('year');
}

/** Montant (libellé en €) : 2 décimales max ; autre grandeur : positive (lot 58A). */
export function numberParseOptionsFor(field: FieldDef): NumberParseOptions {
  return field.label.includes('€') ? MONEY_INPUT : QUANTITY_INPUT;
}

/**
 * Lot 58A — textes saisis des champs numériques → valeurs du formulaire.
 * Conversion à la validation seulement ; un texte invalide bloque tout
 * l'enregistrement (jamais d'envoi partiel).
 */
export function resolveNumberTexts(
  fields: FieldDef[], form: Record<string, unknown>, texts: Record<string, string>,
): { ok: true; form: Record<string, unknown> } | { ok: false; field: FieldDef; error: string } {
  const out = { ...form };
  for (const field of visibleFields(fields, form)) {
    if (field.readonly || !isTypedNumberField(field) || !(field.key in texts)) continue;
    const r = parseNumberInput(texts[field.key], numberParseOptionsFor(field));
    if (!r.ok) return { ok: false, field, error: r.error };
    out[field.key] = r.value;
  }
  return { ok: true, form: out };
}

export function formatValue(value: unknown, field: FieldDef): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'date' && typeof value === 'string') {
    try {
      return new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch { return String(value); }
  }
  if (field.options) {
    const opt = field.options.find(o => o.value === String(value));
    return opt?.label ?? String(value);
  }
  if (field.type === 'number' && field.label.includes('€')) {
    const num = Number(value);
    if (!isNaN(num)) return num.toLocaleString('fr-FR');
  }
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value.map(v => String(v).trim()).filter(v => v).join(', ') || '—';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function AssetDetailSection({
  title, sectionKey, assetId, data, fields, onRefresh, defaultOpen = true, mobileOnly = false,
  forceOpen, forceEdit, readOnly = false, highlightField, headerActions,
  coherenceAlerts = [],
  onDismissAlert,
  onApplyAlert,
}: Props) {
  const fieldDefs = fields;
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({ ...data });
  const [displayData, setDisplayData] = useState<Record<string, unknown>>({ ...data });
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Lot 58A : texte saisi des champs numériques (converti à l'enregistrement).
  const [numberTexts, setNumberTexts] = useState<Record<string, string>>({});
  const [showNumberErrors, setShowNumberErrors] = useState(false);
  // justSaved kept for potential future use but no longer triggers visual feedback
  const justSaved = false;

  const forceEditApplied = useRef(false);
  // Prevents forceOpen/forceEdit from re-opening the section after a successful save
  const savedRef = useRef(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  // Sync displayData when parent data changes (e.g. full page refresh), but not while editing
  useEffect(() => {
    if (!editing) setDisplayData({ ...data });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // When forceEdit transitions to true → enter edit mode with current data
  useEffect(() => {
    if (forceEdit && !forceEditApplied.current && !savedRef.current) {
      forceEditApplied.current = true;
      setForm({ ...data });
      setNumberTexts({});
      setShowNumberErrors(false);
      setEditing(true);
      setOpen(true);
    }
    if (!forceEdit) {
      forceEditApplied.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEdit]);

  // Respond to parent forcing open (without edit)
  useEffect(() => {
    if (forceOpen && !savedRef.current) setOpen(true);
  }, [forceOpen]);

  // Les boutons « Modifier » des onglets informations passent tous par ici.
  const { garder } = useWriteGuard();
  const handleEdit = useCallback(() => {
    garder(() => {
      setForm({ ...data });
      setNumberTexts({});
      setShowNumberErrors(false);
      setDirty(false);
      setEditing(true);
      setOpen(true);
    });
  }, [garder, data]);

  const handleCancel = useCallback(() => {
    if (dirty) {
      setShowCancelConfirm(true);
    } else {
      setEditing(false);
    }
  }, [dirty]);

  const handleSave = useCallback(async () => {
    // Lot 58A : un nombre invalide ou ambigu bloque l'enregistrement (message explicite).
    const resolved = resolveNumberTexts(fieldDefs, form, numberTexts);
    if (!resolved.ok) {
      setShowNumberErrors(true);
      toast.error(`${resolved.field.label} : ${resolved.error}`);
      return;
    }
    const finalForm = resolved.form;
    setIsSaving(true);
    try {
      // Seuls les champs modifiés sont envoyés (lot 20) : un champ non touché
      // n'est ni effacé ni marqué saisi par l'utilisateur.
      // `form` : formulaire dont les textes numériques sont convertis (lot 58A).
      const form = finalForm;
      const fields = changedDetailFields(data, form);
      if (Object.keys(fields).length > 0) {
        await apiClient.patch(`/api/assets/${assetId}/details/${sectionKey}`, { fields });
      }
      setForm(finalForm);
      setNumberTexts({});
      setDisplayData({ ...finalForm });
      savedRef.current = true;
      setEditing(false);
      setDirty(false);
      setOpen(true);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de l\'enregistrement');
    } finally {
      setIsSaving(false);
    }
  }, [assetId, sectionKey, data, form, numberTexts, fieldDefs, onRefresh]);

  const setField = useCallback((key: string, value: unknown) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  return (
    <>
      <div ref={sectionRef} className={`border rounded-lg overflow-hidden transition-colors ${justSaved ? 'border-[color:var(--accent)] bg-[color:var(--bg-success)]' : 'border-border'}`}>
        {/* Header */}
        <button
          className={`w-full flex items-center justify-between px-4 py-3 transition-colors text-left ${
            justSaved
              ? 'bg-[color:var(--bg-success)]'
              : 'bg-muted/30 hover:bg-muted/50'
          }`}
          onClick={() => setOpen(v => !v)}
          type="button"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-sm">{title}</span>
            {coherenceAlerts.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[color:var(--attention-on-soft)] bg-[color:var(--attention-soft)] rounded px-1.5 py-0.5 shrink-0">
                <AlertTriangle className="w-2.5 h-2.5" />
                {coherenceAlerts.length} incohérence{coherenceAlerts.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          {open
            ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          }
        </button>

        {open && (
          <div className="p-4 space-y-3">
            {!editing && !mobileOnly && (
              <div className="flex justify-end gap-2">
                {headerActions}
                {!readOnly && (
                  <Button variant="ghost" size="sm" onClick={handleEdit}>
                    <Pencil className="w-3 h-3 mr-1" />
                    Modifier
                  </Button>
                )}
              </div>
            )}

            {editing ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {visibleFields(fields, form).filter(f => !f.readonly).map(field => {
                  const isNa = field.notApplicableWhen?.(form) ?? false;

                  return (
                    <div key={field.key} className="space-y-1">
                      {/* Label row */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Label className="text-xs text-muted-foreground">{field.label}</Label>
                        {field.badge && (field.key in numberTexts
                          ? numberTexts[field.key] === formatNumberForInput(data[field.key])
                          : String(form[field.key] ?? '') === String(data[field.key] ?? '')) && <FieldBadge text={field.badge(data)} />}
                      </div>

                      {/* Input */}
                      {field.type === 'textarea' ? (
                        <Textarea
                          value={Array.isArray(form[field.key]) ? (form[field.key] as string[]).join('\n') : String(form[field.key] ?? '')}
                          onChange={e => {
                            const value = e.target.value;
                            if (field.key === 'networks') {
                              setField(field.key, value.split('\n').map(s => s.trim()).filter(s => s));
                            } else {
                              setField(field.key, value);
                            }
                          }}
                          rows={3}
                          className=""
                        />
                      ) : field.options ? (
                        <select
                          className="w-full border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:border-primary transition-colors border-input"
                          value={String(form[field.key] ?? '')}
                          onChange={e => setField(field.key, e.target.value)}
                        >
                          <option value="">— Non renseigné —</option>
                          {field.options.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : field.type === 'date' ? (
                        <DatePicker
                          value={String(form[field.key] ?? '')}
                          onChange={v => setField(field.key, v)}
                          min={field.futureOnly ? todayParis() : undefined}
                          className=""
                        />
                      ) : field.type === 'number' && field.key.toLowerCase().includes('year') ? (
                        <YearPicker
                          value={form[field.key] ? String(form[field.key]) : ''}
                          onChange={v => setField(field.key, v ? Number(v) : null)}
                        />
                      ) : field.type === 'number' && field.key.toLowerCase().includes('time') ? (
                        <TimePicker
                          value={String(form[field.key] ?? '')}
                          onChange={v => setField(field.key, v)}
                        />
                      ) : field.type === 'number' ? (
                        <NumberInput
                          value={numberTexts[field.key] ?? formatNumberForInput(form[field.key])}
                          onValueChange={text => { setNumberTexts(prev => ({ ...prev, [field.key]: text })); setDirty(true); }}
                          parseOptions={numberParseOptionsFor(field)}
                          showError={showNumberErrors}
                          aria-label={field.label}
                          showButtons={false}
                          className=""
                        />
                      ) : (
                        <Input
                          type={field.type ?? 'text'}
                          value={String(form[field.key] ?? '')}
                          onChange={e => setField(field.key, e.target.value)}
                          className=""
                        />
                      )}

                    </div>
                  );
                })}

                <div className="flex gap-2 pt-2 col-span-full">
                  <Button size="sm" variant="outline" onClick={handleCancel}>
                    <X className="w-3 h-3 mr-1" />
                    Annuler
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={!dirty || isSaving} data-guide="asset-save-btn">
                    {isSaving
                      ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Enregistrement…</>
                      : <><Check className="w-3 h-3 mr-1" />Enregistrer</>
                    }
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {visibleFields(fields, displayData).map(field => {
                  const isHighlighted = highlightField === field.key;
                  const alert = coherenceAlerts.find(a => a.field === field.key);
                  const isNa = (field.notApplicableWhen?.(displayData) ?? false)
                    && (displayData[field.key] === null || displayData[field.key] === undefined || displayData[field.key] === '');
                  return (
                    <div
                      key={field.key}
                      id={`asset-field-${field.key}`}
                      className={isHighlighted
                        ? 'rounded-lg px-2 py-1.5 -mx-2 ring-2 ring-[color:var(--accent)] bg-[color:var(--accent-soft)] transition-all'
                        : alert
                        ? 'rounded-lg px-2 py-1.5 -mx-2 ring-1 ring-[color:var(--attention-edge)] bg-[color:var(--attention-soft)]'
                        : undefined
                      }
                    >
                      <div className="flex items-center gap-0.5 flex-wrap">
                        <p className="text-xs text-muted-foreground">{field.label}</p>
                        {field.badge && <FieldBadge text={field.badge(displayData)} />}
                        {alert && (
                          <>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-0.5 ml-1 text-[9px] font-semibold text-[color:var(--attention-on-soft)] bg-[color:var(--attention-soft)] rounded px-1.5 py-0.5 cursor-help">
                                    <AlertTriangle className="w-2.5 h-2.5" />
                                    Incohérence
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-sm text-xs space-y-1.5">
                                  <div className="flex items-start gap-1.5">
                                    <AlertTriangle className="w-3 h-3 text-[color:var(--attention-on-soft)] shrink-0 mt-0.5" />
                                    <p className="text-[color:var(--text-warning)] font-medium leading-snug">{alert.issue}</p>
                                  </div>
                                  {alert.suggestedValue && (
                                    <div className="bg-[color:var(--attention-soft)] border border-[color:var(--attention-edge)] rounded px-2 py-1">
                                      <p className="text-[10px] text-[color:var(--attention-on-soft)] uppercase tracking-wider font-semibold">Valeur suggérée</p>
                                      <p className="text-xs font-semibold text-[color:var(--text-warning)]">{alert.suggestedValue}</p>
                                    </div>
                                  )}
                                  {alert.sourceDocument && (
                                    <p className="text-[10px] text-muted-foreground">
                                      <span className="font-medium text-[color:var(--attention-on-soft)]">Document :</span> {alert.sourceDocument}
                                    </p>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {alert.suggestedValue && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onApplyAlert?.(alert.field, alert.suggestedValue!); }}
                                className="inline-flex items-center ml-1 text-[9px] font-semibold text-[color:var(--text-success)] bg-[color:var(--bg-success)] hover:text-[color:var(--text-success)] rounded px-1.5 py-0.5 transition-colors"
                                title="Appliquer la valeur suggérée"
                              >
                                Appliquer
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); onDismissAlert?.(alert.field); }}
                              className="inline-flex items-center ml-1 text-[9px] font-semibold text-[color:var(--attention-on-soft)] bg-[color:var(--attention-soft)] hover:text-[color:var(--text-warning)] rounded px-1.5 py-0.5 transition-colors"
                              title="Conserver ma valeur et ignorer cette incohérence"
                            >
                              Conserver
                            </button>
                          </>
                        )}
                      </div>
                      <p className={`text-sm font-medium mt-0.5 ${isNa ? 'text-muted-foreground italic' : ''}`}>
                        {isNa ? 'N/A' : formatValue(displayData[field.key], field)}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandonner les modifications ?</AlertDialogTitle>
            <AlertDialogDescription>Les modifications non enregistrées seront perdues.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuer l'édition</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setShowCancelConfirm(false);
              setEditing(false);
              setDirty(false);
            }}>
              Abandonner
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
