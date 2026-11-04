"use client";
/**
 * Liste des fournisseurs — `/fournisseurs`.
 *
 * Cible de l'action OPEN_SUPPLIERS de l'assistant (« Voir les fournisseurs »)
 * et du lien « Voir tous » des cartes Fournisseur. Chaque ligne ouvre la fiche
 * unique `/fournisseurs/[id]`. Lecture par `/api/suppliers` (compte actif,
 * IBAN exclu).
 *
 * Lot 109B : TOUS les fournisseurs du compte sont accessibles — recherche
 * côté serveur, pagination (« Afficher plus ») et total exact ; plus de
 * plafond silencieux (100 en liste, 20 en recherche). Recherche, statut et
 * tri sont dans l'adresse (`?q=&statut=&tri=`) : un retour depuis une fiche
 * les retrouve, avec les lignes déjà chargées et la position de défilement.
 * Aucun statut « vérifié / non vérifié ».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Building2, ChevronRight, Loader2, Search } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { supplierHref, SUPPLIERS_ROUTE } from '@/lib/supplier-routes';
import {
  SUPPLIER_LIST_PAGE_MAX, SUPPLIER_LIST_SORTS, SUPPLIER_LIST_SORT_LABELS, suppliersListPath, type SupplierListSort,
  type SupplierListStatus,
} from '@/lib/suppliers/supplier-fiche-config';
import { peekPendingRestore, registerReturnViewState } from '@/lib/suppliers/supplier-return';

interface SupplierRow {
  id: number;
  name: string;
  city: string | null;
  email: string | null;
  phone: string | null;
}
interface ListPage { suppliers: SupplierRow[]; total: number; nextOffset: number | null }

type Statut = SupplierListStatus;
const SELECT_CLS = 'h-11 rounded-md border border-input bg-[color:var(--bg-card)] px-3 text-sm md:h-9';

function apiUrl(q: string, statut: Statut, tri: SupplierListSort, offset: number, limit?: number): string {
  const p = new URLSearchParams({ status: statut, sort: tri, offset: String(offset) });
  if (q.trim()) p.set('search', q.trim());
  if (limit) p.set('limit', String(limit));
  return `/api/suppliers?${p}`;
}

export default function SuppliersPage() {
  const { setBreadcrumbs } = useBreadcrumb();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp?.get('q') ?? '');
  const [statut, setStatut] = useState<Statut>(sp?.get('statut') === 'archived' ? 'archived' : 'active');
  const [tri, setTri] = useState<SupplierListSort>(
    (SUPPLIER_LIST_SORTS as readonly string[]).includes(sp?.get('tri') ?? '') ? (sp!.get('tri') as SupplierListSort) : 'name_asc',
  );
  const [rows, setRows] = useState<SupplierRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const rowsRef = useRef<SupplierRow[]>([]);
  rowsRef.current = rows ?? [];

  useEffect(() => { setBreadcrumbs([{ label: 'Fournisseurs' }]); }, [setBreadcrumbs]);

  // Retour depuis une fiche : autant de lignes que lors du départ.
  const restoreCount = useRef<number>(Number((peekPendingRestore(SUPPLIERS_ROUTE)?.view as { loaded?: number } | null)?.loaded) || 0);
  useEffect(() => registerReturnViewState(SUPPLIERS_ROUTE, () => ({ loaded: rowsRef.current.length })), []);

  // Critères dans l'adresse (remplacement : pas d'entrée d'historique par frappe).
  useEffect(() => {
    const path = suppliersListPath(q, statut, tri);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.replaceState(window.history.state, '', path);
    }
  }, [q, statut, tri]);

  const loadFirst = useCallback(async (signal: { actif: boolean }) => {
    setFailed(false);
    try {
      const want = Math.max(restoreCount.current, 0);
      restoreCount.current = 0;
      let acc: SupplierRow[] = [];
      let page: ListPage = await (await fetch(apiUrl(q, statut, tri, 0), { credentials: 'include' }).then((r) => (r.ok ? r : Promise.reject(r)))).json();
      acc = page.suppliers ?? [];
      while (signal.actif && want > acc.length && page.nextOffset != null) {
        page = await (await fetch(apiUrl(q, statut, tri, page.nextOffset, SUPPLIER_LIST_PAGE_MAX), { credentials: 'include' })
          .then((r) => (r.ok ? r : Promise.reject(r)))).json();
        acc = [...acc, ...(page.suppliers ?? []).filter((x) => !acc.some((a) => a.id === x.id))];
      }
      if (!signal.actif) return;
      setRows(acc);
      setTotal(page.total ?? acc.length);
      setNextOffset(page.nextOffset ?? null);
    } catch {
      if (signal.actif) { setFailed(true); setRows([]); }
    }
  }, [q, statut, tri]);

  useEffect(() => {
    const signal = { actif: true };
    const t = setTimeout(() => { void loadFirst(signal); }, q ? 250 : 0);
    return () => { signal.actif = false; clearTimeout(t); };
  }, [loadFirst, q]);

  const more = async () => {
    if (nextOffset == null) return;
    setLoadingMore(true);
    try {
      const r = await fetch(apiUrl(q, statut, tri, nextOffset), { credentials: 'include' });
      if (!r.ok) throw new Error(String(r.status));
      const page: ListPage = await r.json();
      setRows((prev) => [...(prev ?? []), ...(page.suppliers ?? []).filter((x) => !(prev ?? []).some((p) => p.id === x.id))]);
      setTotal(page.total);
      setNextOffset(page.nextOffset);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtre = q.trim().length > 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="vb-app-title">Fournisseurs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Les entreprises et artisans repérés dans vos documents ou ajoutés par vous.
        </p>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative w-full md:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un fournisseur"
            aria-label="Rechercher un fournisseur"
            className="pl-9"
            maxLength={120}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 md:flex">
          <select aria-label="Fournisseurs affichés" className={SELECT_CLS} value={statut} onChange={(e) => setStatut(e.target.value as Statut)}>
            <option value="active">Actifs</option>
            <option value="archived">Archivés</option>
          </select>
          <select aria-label="Trier par" className={SELECT_CLS} value={tri} onChange={(e) => setTri(e.target.value as SupplierListSort)}>
            {SUPPLIER_LIST_SORTS.map((t) => <option key={t} value={t}>{SUPPLIER_LIST_SORT_LABELS[t]}</option>)}
          </select>
        </div>
      </div>

      {failed && rows?.length === 0 ? (
        <p className="text-sm text-muted-foreground">La liste n’a pas pu être chargée. Réessayez dans un instant.</p>
      ) : rows === null ? (
        <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : rows.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          {filtre
            ? 'Aucun fournisseur ne correspond à votre recherche.'
            : statut === 'archived'
              ? 'Aucun fournisseur archivé.'
              : 'Aucun fournisseur pour le moment. Ils apparaissent dès qu’un document en mentionne un.'}
        </CardContent></Card>
      ) : (
        <Card>
          <CardContent className="pt-2">
            <p className="px-1 pt-2 text-xs text-muted-foreground" data-testid="suppliers-total">
              {total} fournisseur{total > 1 ? 's' : ''}{filtre ? ' trouvé' + (total > 1 ? 's' : '') : ''}
            </p>
            <ul className="divide-y">
              {rows.map((s) => (
                <li key={s.id}>
                  <Link href={supplierHref(s.id)} className="flex items-center gap-3 rounded-md px-1 py-3 hover:bg-muted/40">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[color:var(--accent-soft)]">
                      <Building2 className="h-4 w-4 text-[color:var(--accent)]" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{[s.city, s.email ?? s.phone].filter(Boolean).join(' · ') || 'Aucune coordonnée'}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            {nextOffset != null && (
              <div className="flex flex-col items-center gap-1 border-t pt-3 sm:flex-row sm:justify-between">
                <span className="text-xs text-muted-foreground">{rows.length} sur {total}</span>
                <Button variant="outline" size="sm" className="h-11 w-full sm:h-9 sm:w-auto" onClick={() => { void more(); }} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                  Afficher plus
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
