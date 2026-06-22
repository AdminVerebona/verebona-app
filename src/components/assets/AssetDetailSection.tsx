"use client"

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { YearPicker } from '@/components/ui/year-picker';
import { TimePicker } from '@/components/ui/time-picker';
import { NumberInput } from '@/components/ui/number-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChevronDown, ChevronUp, Pencil, Check, X, Sparkles, Loader2, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

export interface AiSuggestion {
  value: unknown;
  confidence: 'high' | 'medium' | 'low';
}

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  readonly?: boolean;
  /** Retourne true quand le champ est sans objet (affiche N/A, désactivé en édition, envoyé null) */
  notApplicableWhen?: (data: Record<string, unknown>) => boolean;
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
  // AI suggestions support
  aiDraft?: Record<string, AiSuggestion>;
  forceOpen?: boolean;
  forceEdit?: boolean;
  onAiDraftConsumed?: () => void;
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

/** @deprecated Retiré — plus de distinction visuelle auto vs manuel pour l'utilisateur */
const AiBadge = () => null;

const CONFIDENCE_LABELS: Record<string, string> = {
  high: 'Élevée',
  medium: 'Moyenne',
  low: 'Faible',
};

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

function isValueEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '');
}

function valuesAreEqual(a: unknown, b: unknown): boolean {
  return String(a).trim() === String(b).trim();
}

export function AssetDetailSection({
  title, sectionKey, assetId, data, fields, onRefresh, defaultOpen = true, mobileOnly = false,
  aiDraft, forceOpen, forceEdit, onAiDraftConsumed, readOnly = false, highlightField, headerActions,
  coherenceAlerts = [],
  onDismissAlert,
  onApplyAlert,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({ ...data });
  const [displayData, setDisplayData] = useState<Record<string, unknown>>({ ...data });
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // justSaved kept for potential future use but no longer triggers visual feedback
  const justSaved = false;

  // aiInjected: fields pre-filled by AI (empty → injected) — drives badge in read mode
  const [aiInjected, setAiInjected] = useState<Set<string>>(new Set());
  // aiDisplayBadge: fields showing IA badge in read mode (cleared after save or manual edit)
  const [aiDisplayBadge, setAiDisplayBadge] = useState<Set<string>>(new Set());
  // aiConflict: fields where AI suggested a different value than existing — not injected, shown as alternative
  const [aiConflicts, setAiConflicts] = useState<Record<string, AiSuggestion>>({});

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
      setEditing(true);
      setOpen(true);
    }
    if (!forceEdit) {
      forceEditApplied.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEdit]);

  // Apply AI draft — spec §13.1/§13.3
  useEffect(() => {
    if (!aiDraft || Object.keys(aiDraft).length === 0) {
      if (!aiDraft) { setAiInjected(new Set()); setAiConflicts({}); }
      return;
    }
    // New AI draft arriving → allow re-opening for this section again
    savedRef.current = false;

    setForm(prev => {
      const next = { ...prev };
      const injected = new Set<string>();
      const conflicts: Record<string, AiSuggestion> = {};

      for (const [key, suggestion] of Object.entries(aiDraft)) {
        const aiVal = suggestion.value;
        if (isValueEmpty(aiVal)) continue; // §R2 — skip empty

        const existingVal = prev[key];

        if (isValueEmpty(existingVal)) {
          // §13.1 — field is empty → inject
          next[key] = aiVal;
          injected.add(key);
        } else if (!valuesAreEqual(existingVal, aiVal)) {
          // §13.3 — field has a different value → conflict, DO NOT overwrite
          conflicts[key] = suggestion;
        }
        // §13.2 — same value → do nothing
      }

      setAiInjected(injected);
      setAiDisplayBadge(injected); // show badge in read mode for injected fields
      setAiConflicts(conflicts);
      // Also update displayData so read-mode shows AI-injected values immediately
      setDisplayData(prevDisplay => {
        const d = { ...prevDisplay };
        for (const key of injected) d[key] = next[key];
        return d;
      });
      return next;
    });

    setDirty(true);
  }, [aiDraft]);

  // Respond to parent forcing open (without edit)
  useEffect(() => {
    if (forceOpen && !savedRef.current) setOpen(true);
  }, [forceOpen]);

  const handleApplyConflict = useCallback((key: string) => {
    const suggestion = aiConflicts[key];
    if (!suggestion) return;
    setForm(prev => ({ ...prev, [key]: suggestion.value }));
    setAiInjected(prev => new Set([...prev, key]));
    setAiConflicts(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDirty(true);
  }, [aiConflicts]);

  const handleRejectConflict = useCallback((key: string) => {
    setAiConflicts(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleEdit = useCallback(() => {
    setForm({ ...data });
    setAiInjected(new Set());
    setAiConflicts({});
    setDirty(false);
    setEditing(true);
    setOpen(true);
  }, [data]);

  const handleCancel = useCallback(() => {
    if (dirty) {
      setShowCancelConfirm(true);
    } else {
      setEditing(false);
    }
  }, [dirty]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await apiClient.patch(`/api/assets/${assetId}/details/${sectionKey}`, { fields: form });
      setDisplayData({ ...form });
      savedRef.current = true;
      setEditing(false);
      setDirty(false);
      setAiInjected(new Set());
      setAiDisplayBadge(new Set()); // clear badges after save
      setAiConflicts({});
      setOpen(true);
      onRefresh();
      onAiDraftConsumed?.();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de l\'enregistrement');
    } finally {
      setIsSaving(false);
    }
  }, [assetId, sectionKey, form, onRefresh, onAiDraftConsumed]);

  const setField = useCallback((key: string, value: unknown) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    // Remove AI badge when user manually edits the field
    setAiInjected(prev => { const n = new Set(prev); n.delete(key); return n; });
    setAiDisplayBadge(prev => { const n = new Set(prev); n.delete(key); return n; });
  }, []);

  // Count visible suggestions for the collapsed badge
  const suggestionCount = Object.keys(aiConflicts).length +
    [...(aiDraft ? Object.keys(aiDraft) : [])].filter(k =>
      aiInjected.has(k) || k in aiConflicts
    ).length;
  // Simpler: count fields with active AI state
  const activeSuggestionCount = aiInjected.size + Object.keys(aiConflicts).length;

  return (
    <>
      <div ref={sectionRef} className={`border rounded-lg overflow-hidden transition-colors ${justSaved ? 'border-emerald-500 bg-emerald-500/5' : 'border-border'}`}>
        {/* Header */}
        <button
          className={`w-full flex items-center justify-between px-4 py-3 transition-colors text-left ${
            justSaved
              ? 'bg-emerald-500/10 hover:bg-emerald-500/15'
              : 'bg-muted/30 hover:bg-muted/50'
          }`}
          onClick={() => setOpen(v => !v)}
          type="button"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-sm">{title}</span>
            {activeSuggestionCount > 0 && (
              <span className="text-[10px] font-medium text-primary bg-primary/10 rounded px-1.5 py-0.5 shrink-0">
                {activeSuggestionCount} suggestion{activeSuggestionCount > 1 ? 's' : ''}
              </span>
            )}
            {coherenceAlerts.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400 bg-amber-400/10 rounded px-1.5 py-0.5 shrink-0">
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
                {fields.filter(f => !f.readonly).map(field => {
                  const hasConflict = field.key in aiConflicts;
                  const conflictSuggestion = aiConflicts[field.key];
                  const confidence = aiDraft?.[field.key]?.confidence ?? conflictSuggestion?.confidence;
                  const isNa = field.notApplicableWhen?.(form) ?? false;

                  return (
                    <div key={field.key} className="space-y-1">
                      {/* Label row */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Label className="text-xs text-muted-foreground">{field.label}</Label>
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
                          className="w-full border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-colors border-input"
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
                          value={form[field.key] ? Number(form[field.key]) : ''}
                          onChange={e => setField(field.key, e.target.value === '' ? null : Number(e.target.value))}
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

                      {/* §13.3 Conflict banner — suggestion available but not injected */}
                      {hasConflict && conflictSuggestion && (
                        <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50/60 dark:bg-amber-900/10 px-3 py-2 text-xs mt-1">
                          <Sparkles className="w-3 h-3 text-amber-600 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-amber-700 dark:text-amber-400">Suggestion :</span>
                            <span className="ml-1 font-mono text-amber-800 dark:text-amber-300 break-all">
                              {formatValue(conflictSuggestion.value, field)}
                            </span>
                            <span className="ml-1 text-muted-foreground">(valeur actuelle conservée)</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleRejectConflict(field.key)}
                              className="text-muted-foreground hover:text-foreground font-medium hover:underline whitespace-nowrap"
                            >
                              Garder
                            </button>
                            <button
                              type="button"
                              onClick={() => handleApplyConflict(field.key)}
                              className="text-amber-700 dark:text-amber-400 font-medium hover:underline whitespace-nowrap"
                            >
                              Appliquer
                            </button>
                          </div>
                        </div>
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
                {fields.map(field => {
                  const isHighlighted = highlightField === field.key;
                  const alert = coherenceAlerts.find(a => a.field === field.key);
                  const isNa = (field.notApplicableWhen?.(displayData) ?? false)
                    && (displayData[field.key] === null || displayData[field.key] === undefined || displayData[field.key] === '');
                  return (
                    <div
                      key={field.key}
                      id={`asset-field-${field.key}`}
                      className={isHighlighted
                        ? 'rounded-lg px-2 py-1.5 -mx-2 ring-2 ring-violet-400/60 bg-violet-500/5 transition-all'
                        : alert
                        ? 'rounded-lg px-2 py-1.5 -mx-2 ring-1 ring-amber-400/40 bg-amber-400/5'
                        : undefined
                      }
                    >
                      <div className="flex items-center gap-0.5 flex-wrap">
                        <p className="text-xs text-muted-foreground">{field.label}</p>
                        {alert && (
                          <>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-0.5 ml-1 text-[9px] font-semibold text-amber-400 bg-amber-400/10 rounded px-1.5 py-0.5 cursor-help">
                                    <AlertTriangle className="w-2.5 h-2.5" />
                                    Incohérence
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-sm text-xs space-y-1.5">
                                  <div className="flex items-start gap-1.5">
                                    <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                                    <p className="text-amber-300 font-medium leading-snug">{alert.issue}</p>
                                  </div>
                                  {alert.suggestedValue && (
                                    <div className="bg-amber-400/5 border border-amber-400/15 rounded px-2 py-1">
                                      <p className="text-[10px] text-amber-400/70 uppercase tracking-wider font-semibold">Valeur suggérée</p>
                                      <p className="text-xs font-semibold text-amber-300">{alert.suggestedValue}</p>
                                    </div>
                                  )}
                                  {alert.sourceDocument && (
                                    <p className="text-[10px] text-muted-foreground">
                                      <span className="font-medium text-amber-400/70">Document :</span> {alert.sourceDocument}
                                    </p>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {alert.suggestedValue && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onApplyAlert?.(alert.field, alert.suggestedValue!); }}
                                className="inline-flex items-center ml-1 text-[9px] font-semibold text-emerald-400 bg-emerald-400/10 hover:bg-emerald-400/20 hover:text-emerald-300 rounded px-1.5 py-0.5 transition-colors"
                                title="Appliquer la valeur suggérée"
                              >
                                Appliquer
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); onDismissAlert?.(alert.field); }}
                              className="inline-flex items-center ml-1 text-[9px] font-semibold text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 hover:text-amber-300 rounded px-1.5 py-0.5 transition-colors"
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
              setAiInjected(new Set());
              setAiDisplayBadge(new Set()); // clear badges on cancel
              setAiConflicts({});
              onAiDraftConsumed?.();
            }}>
              Abandonner
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
