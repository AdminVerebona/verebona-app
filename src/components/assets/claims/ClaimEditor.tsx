"use client"

/**
 * Éditeur d'un sinistre (lot 44, O5) — état, chargement et enregistrement
 * automatique ; rendu : `ClaimFormView`.
 *
 * Même contrat que l'ancien formulaire (lot 34) : chaque saisie part 700 ms
 * après la dernière frappe (`additional-infos-autosave`), champ par champ ;
 * une liste part EN BLOC avec la `version` connue du sinistre (verrou
 * optimiste) ; un 409 est résolu par `rebaseAfterConflict` (rejoué si la liste
 * serveur n'a pas bougé, sinon la version serveur est affichée et
 * signalée). Biens concernés : enregistrés immédiatement.
 *
 * Utilisé dans la fiche (rubrique « Sinistres ») et dans l'écran de
 * préparation du dossier Assurance-sinistre (`compact`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api-client';
import {
  fieldsFor, findField, interpretFieldInput, listFormState, listValue, sameList, toFieldInput,
  type AdditionalInfoFieldDef, type AdditionalInfoReferencesDto, type AdditionalInfosPatch, type ListItem,
} from '@/lib/assets/additional-infos';
import {
  createAutosaveQueue, patchListPaths, rebaseAfterConflict, withRequeue, type AutosaveQueue, type AutosaveState,
} from '@/lib/assets/additional-infos-autosave';
import { parseWriteBlocked } from '@/lib/write-blocked';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { toExportFamily } from '@/services/exports/catalog';
import { ClaimFormView, type ClaimCostsView } from './ClaimViews';

export interface ClaimResponse {
  id: number;
  claim: Record<string, unknown>;
  version: number;
  label: string;
  assets: Array<{ id: number; name: string; primary: boolean }>;
  costs: ClaimCostsView;
  contractLabel: string | null;
  documented: boolean;
  closed: boolean;
}

interface Props {
  assetId: number;
  claimId: number;
  category: string;
  assetOptions: Array<{ id: number; name: string }>;
  readOnly?: boolean;
  compact?: boolean;
  onBack?: () => void;
  onDeleted?: (remains: boolean) => void;
  /** Sinistre enregistré (libellé de la liste, écran de préparation). */
  onSaved?: () => void;
  onSaveStateChange?: (s: AutosaveState) => void;
}

export function ClaimEditor({ assetId, claimId, category, assetOptions, readOnly = false, compact = false, onBack, onDeleted, onSaved, onSaveStateChange }: Props) {
  const family = toExportFamily(category);
  const url = `/api/assets/${assetId}/claims/${claimId}`;
  const { signalerRefus } = useWriteGuard();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<Record<string, ListItem[]>>({});
  const [listLocalErrors, setListLocalErrors] = useState<Record<string, boolean>>({});
  const [references, setReferences] = useState<AdditionalInfoReferencesDto | null>(null);
  const [saveState, setSaveState] = useState<AutosaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<ClaimResponse, 'label' | 'costs' | 'contractLabel' | 'documented'> | null>(null);
  const [assetIds, setAssetIds] = useState<number[]>([assetId]);
  const versionRef = useRef(0);
  const baseListsRef = useRef<Record<string, ListItem[]>>({});
  const queueRef = useRef<AutosaveQueue | null>(null);
  const cbRef = useRef({ onSaved, onSaveStateChange });
  cbRef.current = { onSaved, onSaveStateChange };

  const adoptServer = useCallback((data: ClaimResponse) => {
    versionRef.current = data.version ?? 0;
    const base: Record<string, ListItem[]> = {};
    for (const def of fieldsFor('claim')) if (def.type === 'list') base[`claim.${def.key}`] = listValue(data.claim, def.key);
    baseListsRef.current = base;
    setMeta({ label: data.label, costs: data.costs, contractLabel: data.contractLabel, documented: data.documented });
    setAssetIds(data.assets.map((a) => a.id));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await apiClient.get<ClaimResponse>(url);
      const next: Record<string, string> = {};
      const nextLists: Record<string, ListItem[]> = {};
      for (const def of fieldsFor('claim', family)) {
        if (def.type === 'list') nextLists[`claim.${def.key}`] = listValue(data.claim, def.key);
        else next[`claim.${def.key}`] = toFieldInput(def, data.claim[def.key] as never);
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
  }, [url, family, adoptServer]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let stop = false;
    apiClient.get<{ references?: AdditionalInfoReferencesDto }>(`/api/assets/${assetId}/claims?include=references`)
      .then((d) => { if (!stop) setReferences(d.references ?? null); })
      .catch(() => undefined);
    return () => { stop = true; };
  }, [assetId]);

  const reportError = useCallback((err: unknown) => {
    const e = err as { status?: number; code?: string; serverMessage?: string };
    const blocked = e?.status === 403 ? parseWriteBlocked({ code: e.code, message: e.serverMessage }) : null;
    if (blocked) signalerRefus(blocked);
    const fields = (err as { details?: { fields?: Array<{ path: string; message: string }> } })?.details?.fields;
    if (Array.isArray(fields) && fields.length) {
      setErrors((prev) => {
        const next = { ...prev };
        for (const f of fields) {
          const m = /^(\w+)\.(\w+)(?:\[(\d+)\])?/.exec(f.path);
          if (m) next[`${m[1]}.${m[2]}`] = m[3] !== undefined ? `Ligne ${Number(m[3]) + 1} : ${f.message}` : f.message;
        }
        return next;
      });
      for (const f of fields) {
        const m = /^claim\.(\w+)/.exec(f.path);
        if (m) queueRef.current?.discard('claim', m[1]);
      }
    }
  }, [signalerRefus]);

  // File d'enregistrement : une par sinistre.
  useEffect(() => {
    const send = (patch: AdditionalInfosPatch) => apiClient.patch<ClaimResponse>(url, {
      claim: patch.claim ?? {}, ...(patchListPaths(patch).length ? { version: versionRef.current } : {}),
    });
    const queue = createAutosaveQueue({
      save: async (patch) => {
        try {
          try {
            adoptServer(await send(patch));
          } catch (err) {
            const e = err as { status?: number; details?: { current?: ClaimResponse } };
            const current = e?.status === 409 ? e.details?.current : undefined;
            if (!current) throw err;
            const { retry, conflicts } = rebaseAfterConflict(patch, baseListsRef.current, { claim: current.claim as never });
            adoptServer(current);
            if (conflicts.length) {
              for (const path of conflicts) queue.block('claim', path.split('.')[1]);
              setLists((prev) => {
                const next = { ...prev };
                for (const path of conflicts) next[path] = listValue(current.claim, path.split('.')[1]);
                return next;
              });
              const labels = conflicts.map((p) => `« ${findField('claim', p.split('.')[1])?.label ?? p} »`);
              setNotice(`${labels.join(', ')} ${conflicts.length > 1 ? 'ont été modifiées' : 'a été modifiée'} entre-temps (autre onglet ou co-titulaire) : la version la plus récente est affichée, votre dernière modification de cette liste n'a pas été enregistrée.`);
            }
            if (Object.keys(retry).length) {
              try {
                adoptServer(await send(retry));
              } catch (e2) {
                throw withRequeue(e2, retry);
              }
            }
          }
        } catch (err) {
          reportError(err);
          throw err;
        }
        cbRef.current.onSaved?.();
      },
      onStateChange: (s) => { setSaveState(s); cbRef.current.onSaveStateChange?.(s); },
    });
    queueRef.current = queue;
    const flushOnHide = () => { if (document.visibilityState === 'hidden') void queue.flush(); };
    document.addEventListener('visibilitychange', flushOnHide);
    return () => {
      document.removeEventListener('visibilitychange', flushOnHide);
      if (queue.hasPending()) void queue.flush();
      queue.dispose();
    };
  }, [url, adoptServer, reportError]);

  const clearError = (path: string) => setErrors((prev) => {
    if (!(path in prev)) return prev;
    const { [path]: _x, ...rest } = prev;
    void _x;
    return rest;
  });

  const onChange = useCallback((def: AdditionalInfoFieldDef, raw: string) => {
    const path = `claim.${def.key}`;
    setInputs((prev) => ({ ...prev, [path]: raw }));
    const r = interpretFieldInput(def, raw);
    const queue = queueRef.current;
    if (!queue) return;
    if (r.kind === 'invalid') {
      setErrors((prev) => ({ ...prev, [path]: r.message }));
      queue.discard('claim', def.key);
      return;
    }
    clearError(path);
    queue.set('claim', def.key, r.kind === 'clear' ? null : r.value);
  }, []);

  const onBlur = useCallback((def: AdditionalInfoFieldDef) => {
    if (def.type !== 'money' && def.type !== 'decimal') return;
    const path = `claim.${def.key}`;
    setInputs((prev) => {
      const r = interpretFieldInput(def, prev[path] ?? '');
      return r.kind === 'set' ? { ...prev, [path]: toFieldInput(def, r.value) } : prev;
    });
  }, []);

  const onListChange = useCallback((def: AdditionalInfoFieldDef, items: ListItem[], opts?: { localError?: boolean }) => {
    const path = `claim.${def.key}`;
    setLists((prev) => ({ ...prev, [path]: items }));
    setListLocalErrors((prev) => ({ ...prev, [path]: !!opts?.localError }));
    clearError(path);
    setNotice(null);
    const queue = queueRef.current;
    if (!queue) return;
    const state = listFormState(def, items);
    if (opts?.localError || !state.payload) { queue.discard('claim', def.key); return; }
    if (sameList(state.payload, baseListsRef.current[path])) { queue.discard('claim', def.key); return; }
    queue.set('claim', def.key, state.payload.length ? state.payload : null);
  }, []);

  /** Événement de l'agenda : sa date devient la date du sinistre si elle n'est pas saisie. */
  const onEventChange = useCallback((def: AdditionalInfoFieldDef, key: string) => {
    onChange(def, key);
    const ev = references?.claimEvents.find((e) => e.key === key);
    const dateDef = findField('claim', 'occurredOn');
    if (ev?.date && dateDef && !(inputs['claim.occurredOn'] ?? '').trim()) onChange(dateDef, ev.date.slice(0, 10));
  }, [onChange, references, inputs]);

  const onToggleAsset = useCallback(async (id: number, checked: boolean) => {
    const next = checked ? [...new Set([...assetIds, id])] : assetIds.filter((a) => a !== id);
    if (!next.length) return;
    setAssetIds(next);
    try {
      await queueRef.current?.flush();
      adoptServer(await apiClient.patch<ClaimResponse>(url, { assetIds: next }));
      cbRef.current.onSaved?.();
    } catch (err) {
      reportError(err);
      setAssetIds(assetIds);
    }
  }, [assetIds, url, adoptServer, reportError]);

  const onDelete = useCallback(async () => {
    if (!window.confirm('Supprimer ce sinistre ? Les documents liés restent dans vos documents.')) return;
    try {
      await queueRef.current?.flush();
      const r = await apiClient.delete<{ removed: boolean; remains: boolean }>(url);
      onDeleted?.(!!r.remains);
    } catch (err) {
      reportError(err);
    }
  }, [url, onDeleted, reportError]);

  if (loading) {
    return <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
  }
  if (loadError) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-red-400" />
        Ce sinistre n&apos;a pas pu être chargé.
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void load()}>Réessayer</button>
      </div>
    );
  }
  return (
    <ClaimFormView
      claimId={claimId}
      idPrefix={`claim-${claimId}`}
      family={family}
      title={meta?.label ?? 'Sinistre'}
      inputs={inputs}
      errors={errors}
      lists={lists}
      listLocalErrors={listLocalErrors}
      references={references}
      readOnly={readOnly}
      saveState={saveState}
      notice={notice}
      assetOptions={assetOptions}
      assetIds={assetIds}
      currentAssetId={assetId}
      costs={meta?.costs ?? null}
      contractLabel={meta?.contractLabel ?? null}
      documented={!!meta?.documented}
      compact={compact}
      onBack={onBack}
      onChange={onChange}
      onBlur={onBlur}
      onListChange={onListChange}
      onEventChange={onEventChange}
      onToggleAsset={(id, c) => void onToggleAsset(id, c)}
      onRetry={() => void queueRef.current?.retry()}
      onDismissNotice={() => setNotice(null)}
      onDelete={onDeleted ? () => void onDelete() : undefined}
    />
  );
}
