"use client";

/**
 * BO › Comptes › fiche d'un compte › « Données du compte » (lot 75N).
 *
 * Section UNIQUE qui remplace les anciennes listes de la fiche (« Biens » non
 * cliquables, tableau des documents en métadonnées) : six catégories (Biens,
 * Équipements, Pièces, Documents, Échéances, Opérations), listes paginées,
 * triées et filtrées CÔTÉ SERVEUR, compteurs réels, actualisation
 * indépendante par catégorie. Un clic ouvre le tiroir commun (`EntityDrawer`)
 * sans perdre la liste (filtres, page et sélection conservés).
 *
 * Lien profond : `?entite=<type>-<id>` (ex. `equipment-456`) ouvre le tiroir ;
 * l'appartenance au compte est vérifiée par le serveur (404 sinon).
 * Desktop : tableau ; mobile : cartes empilées.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Database, Loader2, RefreshCw, Search, Stethoscope } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDate, formatDateTime } from '@/lib/admin/format';
import {
  CATEGORIES, CATEGORY_LABELS, ENTITY_LABELS, entityRef, parseEntityRef, type Category, type EntityType,
} from '@/services/admin/account-data/model';
import type { ListItem, ListResult } from '@/services/admin/account-data/lists';
import { AdminPagination, SortHeader, nextSort } from '../../../../subscriptions/_components/list-controls';
import { EntityDrawer, type EntityRefValue } from './EntityDrawer';

/** Filtres et tris proposés (miroir des listes blanches serveur `LIST_FILTERS` / `LIST_SORTS`). */
const SORT_LABELS: Record<string, string> = { created: 'Création', uploaded: 'Dépôt', id: 'Id', name: 'Nom', updated: 'Modification', date: 'Date' };
const DEFAULT_SORT: Record<Category, string> = { biens: 'created', equipements: 'created', pieces: 'created', documents: 'uploaded', echeances: 'date', operations: 'created' };
const DEFAULT_STATE: Record<Category, string> = { biens: 'all', equipements: 'all', pieces: 'all', documents: 'all', echeances: 'agenda', operations: 'all' };

interface QueryState { q: string; sort: string; dir: 'asc' | 'desc'; page: number; state: string }
const initialQuery = (c: Category): QueryState => ({ q: '', sort: DEFAULT_SORT[c], dir: 'desc', page: 1, state: DEFAULT_STATE[c] });

const STATE_LABELS: Record<string, string> = { active: 'actif', archived: 'archivé', deleted: 'supprimé', invalidated: 'invalidée', merged: 'fusionnée', historique: 'historique' };

function dateText(v: string | null): string {
  if (!v) return '—';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(`${v}T12:00:00`) : formatDateTime(v);
}

function readDeepLink(): EntityRefValue | null {
  if (typeof window === 'undefined') return null;
  return parseEntityRef(new URLSearchParams(window.location.search).get('entite'));
}
function writeDeepLink(ref: EntityRefValue | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (ref) url.searchParams.set('entite', entityRef(ref.type, ref.id));
  else url.searchParams.delete('entite');
  window.history.replaceState(window.history.state, '', url.toString());
}

export function AccountDataSection({ accountId }: { accountId: number }) {
  const [category, setCategory] = useState<Category>('biens');
  const [queries, setQueries] = useState<Record<Category, QueryState>>(() =>
    Object.fromEntries(CATEGORIES.map((c) => [c, initialQuery(c)])) as Record<Category, QueryState>);
  const [results, setResults] = useState<Partial<Record<Category, ListResult>>>({});
  const [errors, setErrors] = useState<Partial<Record<Category, string>>>({});
  const [loading, setLoading] = useState<Category | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [selected, setSelected] = useState<EntityRefValue | null>(null);
  const [drawer, setDrawer] = useState<EntityRefValue | null>(null);
  const [openSeq, setOpenSeq] = useState(0);

  const query = queries[category];

  const load = useCallback(async (c: Category, qs: QueryState) => {
    setLoading(c);
    setErrors((e) => ({ ...e, [c]: undefined }));
    try {
      const p = new URLSearchParams({ q: qs.q, sort: qs.sort, dir: qs.dir, page: String(qs.page), state: qs.state });
      const res = await fetch(`/api/admin/accounts/${accountId}/data/${c}?${p}`, { credentials: 'include', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || body.message || `Erreur ${res.status}`);
      setResults((r) => ({ ...r, [c]: body as ListResult }));
    } catch (e) {
      setErrors((x) => ({ ...x, [c]: e instanceof Error ? e.message : 'Chargement impossible.' }));
    } finally {
      setLoading((l) => (l === c ? null : l));
    }
  }, [accountId]);

  useEffect(() => { void load(category, query); }, [category, query, load]);
  useEffect(() => { setSearchDraft(queries[category].q); }, [category]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lien profond à l'ouverture de la fiche.
  useEffect(() => {
    const ref = readDeepLink();
    if (ref) { setDrawer(ref); setOpenSeq((n) => n + 1); }
  }, []);

  const update = (patch: Partial<QueryState>) => setQueries((q) => ({ ...q, [category]: { ...q[category], ...patch } }));
  const open = (item: ListItem) => {
    const ref = { type: item.type, id: item.id };
    setSelected(ref);
    setDrawer(ref);
    setOpenSeq((n) => n + 1);
    writeDeepLink(ref);
  };
  const changeDrawer = (ref: EntityRefValue | null) => { setDrawer(ref); writeDeepLink(ref); };

  const data = results[category];
  const error = errors[category];
  const filters = data?.counters ?? [];
  const sorts = Object.keys(SORT_LABELS).filter((s) => (category === 'documents' ? ['uploaded', 'id', 'name', 'date', 'updated'] : category === 'echeances' ? ['date', 'id', 'name', 'created'] : category === 'operations' ? ['created'] : ['created', 'id', 'name', 'updated']).includes(s));
  const isSelected = (i: ListItem) => selected?.type === i.type && selected.id === i.id;

  return (
    <section className="rounded-xl border bg-card overflow-hidden" data-account-data>
      <div className="px-5 py-4 border-b space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div>
            <h2 className="vb-app-section flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Données du compte
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Lecture seule : valeurs réellement enregistrées, relations, preuves et historique. Aucune modification, aucun traitement IA déclenché.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 self-stretch sm:self-start">
            {/* Lot 88A : diagnostic global du compte (BO › Supervision › Diagnostics techniques, périmètre « Un compte »). */}
            <Button asChild variant="outline" size="sm" className="gap-1.5 w-full sm:w-auto">
              <Link href={`/admin/diagnostics?scope=account&id=${accountId}&period=all`}><Stethoscope className="h-3.5 w-3.5" /> Diagnostic global</Link>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5 w-full sm:w-auto" onClick={() => void load(category, query)} disabled={loading === category}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading === category ? 'animate-spin' : ''}`} /> Actualiser
            </Button>
          </div>
        </div>
        <Tabs value={category} onValueChange={(v) => setCategory(v as Category)}>
          <TabsList className="flex-wrap h-auto w-full sm:w-fit">
            {CATEGORIES.map((c) => (
              <TabsTrigger key={c} value={c} className="text-xs sm:text-[13px]">
                {CATEGORY_LABELS[c]}
                {results[c] && <span className="opacity-70 tabular-nums">({results[c]!.counters.reduce((n, x) => (c === 'echeances' ? n + x.count : x.value === 'all' ? x.count : n), 0)})</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-col md:flex-row md:items-end gap-2">
          <form
            className="flex gap-2 flex-1 min-w-0"
            onSubmit={(e) => { e.preventDefault(); update({ q: searchDraft.trim(), page: 1 }); }}
            role="search"
          >
            <Input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Nom, référence ou identifiant"
              aria-label={`Rechercher dans ${CATEGORY_LABELS[category]}`}
              className="h-9"
            />
            <Button type="submit" variant="outline" size="sm" className="h-9 gap-1.5"><Search className="h-3.5 w-3.5" />Rechercher</Button>
          </form>
          <div className="flex gap-2">
            <Select value={query.state} onValueChange={(v) => update({ state: v, page: 1 })}>
              <SelectTrigger className="h-9 w-full md:w-56" aria-label="Filtrer par état"><SelectValue /></SelectTrigger>
              <SelectContent>
                {filters.map((f) => <SelectItem key={f.value} value={f.value}>{f.label} ({f.count})</SelectItem>)}
                {!filters.length && <SelectItem value={query.state}>{query.state}</SelectItem>}
              </SelectContent>
            </Select>
            <Select value={query.sort} onValueChange={(v) => update({ sort: v, page: 1 })}>
              <SelectTrigger className="h-9 w-full md:w-40 md:hidden" aria-label="Trier par"><SelectValue /></SelectTrigger>
              <SelectContent>{sorts.map((s) => <SelectItem key={s} value={s}>Tri : {SORT_LABELS[s]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {error ? (
        <div className="px-5 py-4 text-sm text-[color:var(--text-danger)]" role="alert">
          {error} <button type="button" className="underline" onClick={() => void load(category, query)}>Réessayer</button>
        </div>
      ) : !data || data.category !== category ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : data.total === 0 ? (
        <p className="px-5 py-6 text-center text-muted-foreground italic text-xs">Aucun élément{query.q ? ` pour « ${query.q} »` : ''}.</p>
      ) : (
        <div className={`space-y-3 pb-3 ${loading === category ? 'opacity-60' : ''}`}>
          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[12.5px] font-semibold text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-4 py-2 text-left">{sorts.includes('id') ? <SortHeader label="Id" sortKey="id" current={query.sort} dir={query.dir} onSort={(k) => update({ ...nextSort(query.sort, query.dir, k), page: 1 })} /> : 'Id'}</th>
                  <th className="px-4 py-2 text-left">{sorts.includes('name') ? <SortHeader label="Nom" sortKey="name" current={query.sort} dir={query.dir} onSort={(k) => update({ ...nextSort(query.sort, query.dir, k), page: 1 })} /> : 'Nom'}</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Statut</th>
                  <th className="px-4 py-2 text-left font-medium">Rattachement</th>
                  <th className="px-4 py-2 text-left"><SortHeader label="Dates" sortKey={sorts[0]} current={query.sort} dir={query.dir} onSort={(k) => update({ ...nextSort(query.sort, query.dir, k), page: 1 })} /></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map((i) => (
                  <tr
                    key={`${i.type}-${i.id}`}
                    tabIndex={0}
                    role="button"
                    aria-label={`Ouvrir ${ENTITY_LABELS[i.type]} #${i.id} ${i.name}`}
                    onClick={() => open(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); } }}
                    className={`cursor-pointer hover:bg-muted/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)] ${isSelected(i) ? 'bg-[color:var(--accent-soft)]' : ''}`}
                    data-entity={entityRef(i.type, i.id)}
                  >
                    <td className="px-4 py-2 font-mono text-muted-foreground">#{i.id}</td>
                    <td className="px-4 py-2 font-medium">{i.name}</td>
                    <td className="px-4 py-2">{i.kind ?? '—'}</td>
                    <td className="px-4 py-2">{i.statusLabel ?? '—'}{i.state !== 'active' && <span className="ml-1 text-muted-foreground">({STATE_LABELS[i.state] ?? i.state})</span>}</td>
                    <td className="px-4 py-2">{i.parent ? `${ENTITY_LABELS[i.parent.type]} #${i.parent.id} — ${i.parent.label}` : '—'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{i.dates.map((d) => <span key={d.label} className="block">{d.label} : {dateText(d.value)}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile */}
          <ul className="md:hidden divide-y">
            {data.items.map((i) => (
              <li key={`${i.type}-${i.id}`}>
                <button
                  type="button"
                  onClick={() => open(i)}
                  className={`w-full text-left px-5 py-3 hover:bg-muted/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)] ${isSelected(i) ? 'bg-[color:var(--accent-soft)]' : ''}`}
                  data-entity={entityRef(i.type, i.id)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium break-words">{i.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground shrink-0">#{i.id}</span>
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{[i.kind, i.statusLabel, i.state !== 'active' ? STATE_LABELS[i.state] ?? i.state : null].filter(Boolean).join(' · ')}</span>
                  {i.parent && <span className="block text-[11px] text-muted-foreground">{ENTITY_LABELS[i.parent.type]} : {i.parent.label}</span>}
                  <span className="block text-[11px] text-muted-foreground">{i.dates.map((d) => `${d.label} ${dateText(d.value)}`).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="px-5">
            <AdminPagination page={data.page} totalPages={data.totalPages} total={data.total} disabled={loading === category} onPage={(p) => update({ page: p })} />
          </div>
        </div>
      )}

      <EntityDrawer
        accountId={accountId}
        current={drawer}
        openSeq={openSeq}
        onChange={changeDrawer}
        onClose={() => changeDrawer(null)}
      />
    </section>
  );
}

export type { EntityType };
