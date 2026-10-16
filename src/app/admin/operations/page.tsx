"use client";

/**
 * Opérations — BO diagnostic (lot 47A, O9 — CDC Opérations V1 ch. 21, B23,
 * C26.1, C26.2 ; décisions PO Q8, Q9).
 *
 *   · « Opérations » : liste filtrable (compte, type, statut, actives /
 *     invalidées / fusionnées, sans bien, sans source, période de création),
 *     paginée ; chaque ligne ouvre le détail ;
 *   · « En attente T3 » : candidats T1 en HOLD / arbitrage avec leur motif
 *     (global ou d'un compte) ;
 *   · « Indicateurs » : les 13 indicateurs C26.2 (global ou d'un compte,
 *     période) et les anomalies dures en alerte, avec la procédure ;
 *   · « Coût de possession » (lot 61) : diagnostic du TCO d'un bien du
 *     compte — chaque ligne retenue ou écartée et son motif (lecture seule).
 *
 * LECTURE SEULE : aucun bouton d'action sur une Opération (INV-032, F-182).
 * Lot 48 (O10) : filtré sur un compte, « Reconsolider ce compte » met en
 * file le passage T3 complet du compte (action de compte avec motif,
 * journalisée — jamais une édition d'Opération, décision PO Q9 ; composant
 * `ReconsolidateAccountButton`, desktop et mobile).
 *
 * NAVIGATION : la barre latérale porte EXACTEMENT les 15 entrées du CDC BO
 * (test `admin-sidebar.test.ts`) ; comme « Exploitation », la page est
 * atteinte depuis Dashboard › Supervision et depuis la fiche d'un compte
 * (« Opérations du compte »). Garde : layout `/admin` + `requireAdmin` sur
 * chaque route. Onglet, filtres et page vivent dans l'URL (UX-004). Desktop
 * et mobile : mêmes composants (`_components/views.tsx`).
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Layers, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { AdminPagination } from '../subscriptions/_components/list-controls';
import type { HoldListResult, IndicatorsReport, OperationListResult } from '@/services/business-operations/diagnostics/service';
import { HoldsTable, IndicatorsView, OperationsTable, ReadOnlyNotice, t3QueueHref } from './_components/views';
import { ReconsolidateAccountButton } from './_components/ReconsolidateAccountButton';
import { TcoDiagnosticView, type TcoDiagnosticResponse } from './_components/TcoDiagnostic';

const TABS = [
  { key: 'liste', label: 'Opérations' },
  { key: 'attente', label: 'En attente T3' },
  { key: 'indicateurs', label: 'Indicateurs' },
  { key: 'tco', label: 'Coût de possession' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const TYPES: Array<[string, string]> = [
  ['ACQUISITION', 'Acquisition'], ['CLAIM', 'Sinistre'], ['CONTRACT', 'Contrat'], ['DISPOSAL', 'Cession'],
  ['FINANCING', 'Financement'], ['INTERVENTION', 'Intervention'], ['OTHER', 'Autre'], ['NULL', 'Type non qualifié'],
];
const selectCls = 'rounded-md border bg-background px-3 py-2 text-sm';

/** Lecture JSON d'une route BO ; 401/403 → connexion. */
function useAdminJson<T>(url: string | null) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) { router.push('/login?returnUrl=/admin/operations'); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `Erreur ${res.status}`);
      setData(body as T);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Erreur réseau.');
    } finally {
      setLoading(false);
    }
  }, [url, router]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

function Operations() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab: TabKey = (TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab') : 'liste') as TabKey;
  const accountId = /^\d+$/.test(sp.get('accountId') ?? '') ? sp.get('accountId')! : '';
  const [accountInput, setAccountInput] = useState(accountId);
  useEffect(() => { setAccountInput(accountId); }, [accountId]);
  const assetId = /^\d+$/.test(sp.get('assetId') ?? '') ? sp.get('assetId')! : '';
  const [assetInput, setAssetInput] = useState(assetId);
  useEffect(() => { setAssetInput(assetId); }, [assetId]);

  const setQuery = useCallback((next: Record<string, string | null>) => {
    const qs = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    router.replace(`${pathname}?${qs}`, { scroll: false });
  }, [sp, pathname, router]);

  const keep = (keys: string[]) => {
    const qs = new URLSearchParams();
    for (const k of keys) { const v = sp.get(k); if (v) qs.set(k, v); }
    return qs.toString();
  };
  const listUrl = tab === 'liste' ? `/api/admin/operations?${keep(['accountId', 'type', 'status', 'state', 'withoutAsset', 'withoutSource', 'from', 'to', 'page'])}` : null;
  const holdsUrl = tab === 'attente' ? `/api/admin/operations/holds?${keep(['accountId', 'outcome', 'reason', 'page'])}` : null;
  const indicatorsUrl = tab === 'indicateurs' ? `/api/admin/operations/indicators?${keep(['accountId', 'from', 'to'])}` : null;
  const tcoUrl = tab === 'tco' && accountId && assetId ? `/api/admin/operations/tco?${keep(['accountId', 'assetId'])}` : null;
  const tco = useAdminJson<TcoDiagnosticResponse>(tcoUrl);
  const list = useAdminJson<OperationListResult>(listUrl);
  const holds = useAdminJson<HoldListResult>(holdsUrl);
  const indicators = useAdminJson<IndicatorsReport>(indicatorsUrl);
  const current = tab === 'liste' ? list : tab === 'attente' ? holds : tab === 'tco' ? tco : indicators;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <Link href={accountId ? `/admin/accounts/${accountId}` : '/admin?tab=supervision'} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> {accountId ? `Compte #${accountId}` : 'Dashboard › Supervision'}
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2 mt-1">
            <Layers className="h-6 w-6" />
            Opérations{accountId ? ` du compte #${accountId}` : ''}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Diagnostic des Opérations métier consolidées — lecture seule</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => current.reload()} disabled={current.loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${current.loading ? 'animate-spin' : ''}`} /> Actualiser
        </Button>
      </div>

      <ReadOnlyNotice />

      {/* Filtre commun : compte (toutes les vues). */}
      <div className="flex flex-col md:flex-row gap-3 md:items-center">
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setQuery({ accountId: /^\d+$/.test(accountInput.trim()) ? accountInput.trim() : null, page: null }); }}
        >
          <Input aria-label="Identifiant du compte" placeholder="N° de compte" inputMode="numeric" value={accountInput}
            onChange={(e) => setAccountInput(e.target.value)} className="w-40" />
          <Button type="submit" variant="outline" size="sm">Filtrer</Button>
        </form>
        {accountId && (
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-x-4 gap-y-2 text-sm">
            <Link href={`/admin/accounts/${accountId}`} className="underline">Fiche du compte</Link>
            <Link href={t3QueueHref(Number(accountId))} className="underline">Travaux T3 du compte (File IA)</Link>
            <button type="button" className="underline text-muted-foreground text-left" onClick={() => setQuery({ accountId: null, page: null })}>Tous les comptes</button>
            <ReconsolidateAccountButton accountId={Number(accountId)} onQueued={() => void current.reload()} />
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setQuery({ tab: v === 'liste' ? null : v, page: null })}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="liste" className="pt-4 space-y-3">
          <div className="flex flex-col md:flex-row md:flex-wrap gap-3">
            <select aria-label="Type" className={selectCls} value={sp.get('type') ?? ''} onChange={(e) => setQuery({ type: e.target.value || null, page: null })}>
              <option value="">Tous les types</option>
              {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select aria-label="Statut" className={selectCls} value={sp.get('status') ?? ''} onChange={(e) => setQuery({ status: e.target.value || null, page: null })}>
              <option value="">Tous les statuts</option>
              <option value="ENVISAGED">Envisagée</option>
              <option value="REALIZED">Réalisée</option>
              <option value="CANCELLED">Annulée</option>
            </select>
            <select aria-label="État" className={selectCls} value={sp.get('state') ?? ''} onChange={(e) => setQuery({ state: e.target.value || null, page: null })}>
              <option value="">Actives, invalidées et fusionnées</option>
              <option value="active">Actives</option>
              <option value="invalidated">Invalidées</option>
              <option value="merged">Fusionnées</option>
            </select>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sp.get('withoutAsset') === '1'} onChange={(e) => setQuery({ withoutAsset: e.target.checked ? '1' : null, page: null })} />
              Sans bien
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sp.get('withoutSource') === '1'} onChange={(e) => setQuery({ withoutSource: e.target.checked ? '1' : null, page: null })} />
              Sans source active
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              Créées du
              <Input type="date" aria-label="Créées depuis le" className="w-auto" value={sp.get('from') ?? ''} onChange={(e) => setQuery({ from: e.target.value || null, page: null })} />
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              au
              <Input type="date" aria-label="Créées jusqu’au" className="w-auto" value={sp.get('to') ?? ''} onChange={(e) => setQuery({ to: e.target.value || null, page: null })} />
            </label>
          </div>
          {list.error ? <EcranEnErreur titre="Chargement des Opérations impossible" message={list.error} onRetry={list.reload} />
            : !list.data ? <Spinner />
              : (
                <div className={`space-y-3 ${list.loading ? 'opacity-60' : ''}`}>
                  <OperationsTable items={list.data.items} />
                  <AdminPagination page={list.data.page} totalPages={list.data.totalPages} total={list.data.total} disabled={list.loading}
                    onPage={(p) => setQuery({ page: String(p) })} />
                </div>
              )}
        </TabsContent>

        <TabsContent value="attente" className="pt-4 space-y-3">
          {holds.data && (
            <div className="flex flex-col md:flex-row gap-3 md:items-center">
              <select aria-label="Issue" className={selectCls} value={sp.get('outcome') ?? ''} onChange={(e) => setQuery({ outcome: e.target.value || null, page: null })}>
                <option value="">HOLD et arbitrages</option>
                <option value="HOLD_UNRESOLVED">En attente (HOLD)</option>
                <option value="ARBITRATION_REQUIRED">Arbitrage (À traiter)</option>
              </select>
              <select aria-label="Motif" className={selectCls} value={sp.get('reason') ?? ''} onChange={(e) => setQuery({ reason: e.target.value || null, page: null })}>
                <option value="">Tous les motifs</option>
                {holds.data.reasons.some((r) => r.reason?.startsWith('TECHNICAL_ERROR:')) && <option value="TECHNICAL_ERROR">Erreurs techniques</option>}
                {holds.data.reasons.filter((r) => r.reason).map((r) => (
                  <option key={`${r.outcome}:${r.reason}`} value={r.reason!}>{r.label} ({r.count})</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{holds.data.pendingT3} candidat(s) établi(s) encore en file T3.</p>
            </div>
          )}
          {holds.error ? <EcranEnErreur titre="Chargement des candidats impossible" message={holds.error} onRetry={holds.reload} />
            : !holds.data ? <Spinner />
              : (
                <div className={`space-y-3 ${holds.loading ? 'opacity-60' : ''}`}>
                  <HoldsTable items={holds.data.items} />
                  <AdminPagination page={holds.data.page} totalPages={holds.data.totalPages} total={holds.data.total} disabled={holds.loading}
                    onPage={(p) => setQuery({ page: String(p) })} />
                </div>
              )}
        </TabsContent>

        <TabsContent value="indicateurs" className="pt-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <label className="inline-flex items-center gap-2 text-sm">
              Du
              <Input type="date" aria-label="Période : début" className="w-auto" value={sp.get('from') ?? ''} onChange={(e) => setQuery({ from: e.target.value || null })} />
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              au
              <Input type="date" aria-label="Période : fin" className="w-auto" value={sp.get('to') ?? ''} onChange={(e) => setQuery({ to: e.target.value || null })} />
            </label>
            <p className="text-xs text-muted-foreground">30 derniers jours par défaut, 366 jours au plus.</p>
          </div>
          {indicators.error ? <EcranEnErreur titre="Calcul des indicateurs impossible" message={indicators.error} onRetry={indicators.reload} />
            : !indicators.data ? <Spinner />
              : <div className={indicators.loading ? 'opacity-60' : ''}><IndicatorsView report={indicators.data} /></div>}
        </TabsContent>

        <TabsContent value="tco" className="pt-4 space-y-3">
          <form
            className="flex flex-col sm:flex-row gap-2 sm:items-center"
            onSubmit={(e) => { e.preventDefault(); setQuery({ assetId: /^\d+$/.test(assetInput.trim()) ? assetInput.trim() : null }); }}
          >
            <Input aria-label="Identifiant du bien" placeholder="N° de bien" inputMode="numeric" value={assetInput}
              onChange={(e) => setAssetInput(e.target.value)} className="w-40" />
            <Button type="submit" variant="outline" size="sm">Diagnostiquer</Button>
            <p className="text-xs text-muted-foreground">Compte et bien requis. Même calcul que l’application (tiroir et assistant), recalculé à la demande.</p>
          </form>
          {!accountId || !assetId ? <p className="text-sm text-muted-foreground">Renseignez le compte puis le bien.</p>
            : tco.error ? <EcranEnErreur titre="Diagnostic du coût de possession impossible" message={tco.error} onRetry={tco.reload} />
              : !tco.data ? <Spinner />
                : <div className={tco.loading ? 'opacity-60' : ''}><TcoDiagnosticView data={tco.data} /></div>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Spinner() {
  return <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;
}

export default function AdminOperationsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Operations />
    </Suspense>
  );
}
