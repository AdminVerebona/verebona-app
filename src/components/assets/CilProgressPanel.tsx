"use client"

/**
 * Carnet d'information du logement — avancement dans l'onglet Informations
 * (lot 111U). Remplace la « Checklist CIL » documentaire (Disponible / Non
 * renseigné) par l'état du SERVICE COMMUN (`/api/assets/[id]/cil-checklist`,
 * même projection que la préparation et le PDF) :
 *   · avancement réglementaire (obligations applicables) et couverture
 *     complémentaire SÉPARÉE ;
 *   · blocs B1-B9, données renseignées / partielles / manquantes / à confirmer
 *     / non applicables, valeurs connues et source OUVRABLE ;
 *   · actions : Voir le document, Compléter, Non applicable (si autorisé) ;
 *   · une erreur de chargement est une ERREUR (message + Réessayer), jamais
 *     un « 0 / N » trompeur ; aucun « gaz non applicable » déduit.
 * Rafraîchi après toute mutation pertinente (événements de l'application).
 * Même composant sur ordinateur et mobile (interface web), charte Sérénité.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, FileText, RotateCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { CIL_STATUS_LABELS, type CilItemStatus } from '@/lib/cil/cil-catalog';
import type { CilState, CilStateItem } from '@/lib/cil/cil-state-types';

/** Événements après lesquels l'état est relu (import, analyse, rattachement, champ, équipement, agenda, décision). */
export const CIL_REFRESH_EVENTS = [
  'asset-details-updated', 'document-added', 'document-deleted', 'document-analysis-complete', 'agenda-mutated', 'cil-state-refresh',
] as const;

const TONE: Record<CilItemStatus, string> = {
  renseigne: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]',
  partiel: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)]',
  manquant: 'bg-muted/60 text-muted-foreground',
  a_confirmer: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)]',
  non_applicable: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]',
};

function StatusPill({ status }: { status: CilItemStatus }) {
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${TONE[status]}`}>{CIL_STATUS_LABELS[status]}</span>;
}

function actionHref(assetId: number, it: CilStateItem): string | null {
  const a = it.action;
  if (!a) return null;
  switch (a.kind) {
    case 'complete_field': return `/assets/${assetId}?tab=details&highlight=${encodeURIComponent(a.target ?? '')}`;
    case 'add_document': return `/assets/${assetId}?tab=documents`;
    case 'equipments': return `/assets/${assetId}?tab=equipments`;
    case 'agenda': return `/assets/${assetId}?tab=agenda`;
    case 'materials': case 'cil_profile': return `/assets/${assetId}?tab=exports`;
    default: return null;
  }
}

const openDocument = (fileId: number) => window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));

const TRIGGER_OPTIONS = [
  { value: 'construction', label: 'Construction neuve' },
  { value: 'renovation_energetique', label: 'Rénovation énergétique' },
  { value: 'volontaire', label: 'Démarche volontaire' },
] as const;

/** B2 — motif et date de constitution, à saisir quand aucun document ne les établit (route `cil-profile`, origine USER). */
function ProfileForm({ assetId, onChanged }: { assetId: number; onChanged: () => void }) {
  const [trigger, setTrigger] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!trigger) { setError('Choisissez le motif.'); return; }
    setBusy(true); setError(null);
    try {
      await apiClient.post(`/api/assets/${assetId}/cil-profile`, { triggerType: trigger, triggerDate: date || null });
      onChanged();
    } catch { setError('Le contexte n’a pas pu être enregistré.'); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end" data-testid="cil-profile-form">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">Motif
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-xs text-foreground">
          <option value="">Choisir…</option>
          {TRIGGER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-xs text-foreground" />
      </label>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()}>{busy ? 'Enregistrement…' : 'Enregistrer'}</Button>
      {error && <p role="alert" className="text-[11px] text-[color:var(--text-danger)]">{error}</p>}
    </div>
  );
}

function Item({ assetId, it, readOnly, onChanged }: { assetId: number; it: CilStateItem; readOnly: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profileForm = !readOnly && it.id === 'B2.trigger' && it.status !== 'renseigne';
  const href = profileForm || it.status === 'renseigne' || it.status === 'non_applicable' ? null : actionHref(assetId, it);
  const canNa = !readOnly && it.naAllowed && (it.status === 'manquant' || it.status === 'a_confirmer');
  const declared = it.notApplicable?.by === 'user';

  const resolve = async (mode: 'set' | 'unset') => {
    setBusy(true); setError(null);
    try {
      if (mode === 'set') {
        await apiClient.patch(`/api/assets/${assetId}/exports/cil/resolutions`, { blockId: it.id, resolution: 'not_applicable', justification: null });
      } else {
        await apiClient.delete(`/api/assets/${assetId}/exports/cil/resolutions?blockId=${encodeURIComponent(it.id)}`);
      }
      onChanged();
    } catch (e) {
      setError((e as Error)?.message || 'La déclaration n’a pas pu être enregistrée.');
    } finally { setBusy(false); }
  };

  return (
    <li className="py-2 border-b border-border/20 last:border-0" data-testid={`cil-item-${it.id}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`text-xs min-w-0 ${it.status === 'renseigne' ? 'text-foreground' : 'text-muted-foreground'}`}>
          {it.label}
          {it.category === 'COMPLEMENT' && <span className="ml-1 text-[10px] text-muted-foreground">(complément)</span>}
        </span>
        <StatusPill status={it.status} />
      </div>
      {it.values.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {it.values.slice(0, 6).map((v, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <span className="text-foreground/80 break-words">{v.label}{v.value && v.value !== v.label ? ` — ${v.value}` : ''}</span>
              {v.source?.fileId ? (
                <button type="button" onClick={() => openDocument(v.source!.fileId!)} className="inline-flex items-center gap-1 underline-offset-2 hover:underline text-[color:var(--accent)]">
                  <FileText className="w-3 h-3" aria-hidden />Voir le document{v.source.page ? ` (p. ${v.source.page})` : ''}
                </button>
              ) : v.source ? <span>{v.source.label}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {it.missing.length > 0 && it.status !== 'manquant' && (
        <p className="mt-1 text-[11px] text-muted-foreground">À compléter : {it.missing.join(', ')}</p>
      )}
      {it.reason && <p className="mt-1 text-[11px] text-muted-foreground">{it.reason}</p>}
      {it.notApplicable?.justification && <p className="mt-1 text-[11px] text-muted-foreground">{it.notApplicable.justification}</p>}
      {(href || canNa || (declared && !readOnly)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {href && !readOnly && (
            <a href={href} className="inline-flex items-center gap-1 text-[11px] font-medium text-[color:var(--accent)] underline-offset-2 hover:underline">
              {it.status === 'a_confirmer' && it.counted ? 'Vérifier et compléter' : it.action?.label}<ExternalLink className="w-3 h-3" aria-hidden />
            </a>
          )}
          {canNa && (
            <button type="button" disabled={busy} onClick={() => resolve('set')} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50">
              {busy ? 'Enregistrement…' : 'Non applicable pour ce logement'}
            </button>
          )}
          {declared && !readOnly && it.naAllowed && (
            <button type="button" disabled={busy} onClick={() => resolve('unset')} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50">
              Annuler « non applicable »
            </button>
          )}
        </div>
      )}
      {profileForm && <ProfileForm assetId={assetId} onChanged={onChanged} />}
      {error && <p role="alert" className="mt-1 text-[11px] text-[color:var(--text-danger)]">{error}</p>}
    </li>
  );
}

export function CilProgressPanel({ assetId, readOnly = false, defaultOpen = false }: { assetId: number; readOnly?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [state, setState] = useState<CilState | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle');
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setStatus((s) => (s === 'ready' ? 'ready' : 'loading'));
    try {
      const r = await apiClient.get<{ state: CilState }>(`/api/assets/${assetId}/cil-checklist`, { useCache: false });
      if (n !== seq.current) return;
      if (!r?.state?.blocks) throw new Error('INVALID');
      setState(r.state);
      setStatus('ready');
    } catch {
      if (n !== seq.current) return;
      setStatus('error');
    }
  }, [assetId]);

  // Chargé à l'ouverture, puis relu après chaque mutation pertinente (tant que le panneau a été ouvert une fois).
  useEffect(() => { if (open && status === 'idle') void load(); }, [open, status, load]);
  useEffect(() => {
    if (status === 'idle') return;
    const h = (e: Event) => {
      const id = (e as CustomEvent<{ assetId?: number }>).detail?.assetId;
      if (!id || id === assetId) void load();
    };
    for (const ev of CIL_REFRESH_EVENTS) window.addEventListener(ev, h);
    return () => { for (const ev of CIL_REFRESH_EVENTS) window.removeEventListener(ev, h); };
  }, [status, assetId, load]);

  const reg = state?.regulatory;
  return (
    <div className="border rounded-lg overflow-hidden" data-testid="cil-progress-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-medium text-sm">Carnet d’information du logement</span>
          {status === 'ready' && reg && (
            <span className="text-[10px] font-medium text-[color:var(--accent)] bg-[color:var(--accent-soft)] rounded px-1.5 py-0.5 shrink-0">
              {reg.percentage} % des informations attendues
            </span>
          )}
          {status === 'error' && <span className="text-[10px] font-medium text-[color:var(--text-danger)] shrink-0">Indisponible</span>}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {status === 'loading' || status === 'idle' ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
          ) : status === 'error' || !state ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm">L’état du carnet n’a pas pu être chargé. Vos informations ne sont pas perdues.</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                <RotateCw className="w-3.5 h-3.5" aria-hidden />Réessayer
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-2xl font-semibold tabular-nums leading-none">{state.regulatory.percentage} %</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Informations attendues pour ce logement : {fmt(state.regulatory.done)} sur {state.regulatory.applicable}
                    {state.regulatory.aConfirmer > 0 ? ` · ${state.regulatory.aConfirmer} à confirmer` : ''}
                  </p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-2xl font-semibold tabular-nums leading-none">{state.complement.percentage} %</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Informations complémentaires proposées par Verebona</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Une donnée renseignée compte pour 1, une donnée partielle pour ½ ; les éléments non applicables ou dont la présence reste à confirmer ne sont pas comptés.
                Cet état reflète les informations disponibles dans Verebona ; il ne constitue pas une validation réglementaire.
              </p>
              {state.recommendations.count > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Des recommandations de travaux figurent dans vos diagnostics : elles restent des recommandations et ne sont pas comptées comme travaux réalisés.
                </p>
              )}
              <ul className="divide-y divide-border rounded-lg border">
                {state.blocks.map((b) => {
                  const isOpen = openBlock === b.id;
                  return (
                    <li key={b.id} data-testid={`cil-block-${b.id}`}>
                      <button type="button" onClick={() => setOpenBlock(isOpen ? null : b.id)} aria-expanded={isOpen}
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/30">
                        <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">{b.id}</span>
                        <span className="min-w-0 flex-1 text-sm">{b.label}</span>
                        <StatusPill status={b.status} />
                        {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                      </button>
                      {isOpen && (
                        <div className="px-3 pb-3 sm:pl-12">
                          {b.notice && <p className="mb-1 text-[11px] text-muted-foreground">{b.notice}</p>}
                          <ul>{b.items.map((it) => <Item key={it.id} assetId={assetId} it={it} readOnly={readOnly} onChanged={() => window.dispatchEvent(new CustomEvent('cil-state-refresh', { detail: { assetId } }))} />)}</ul>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
