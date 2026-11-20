"use client";

/**
 * Carte Trello #806, volet B §8 — LISTE DES OPÉRATIONS du compte (ordinateur et
 * mobile : même composant ; une colonne sur mobile, une grille de repères sur
 * grand écran ; charte Sérénité — jetons de couleur seulement ; cibles
 * tactiles de 44 px).
 *
 * Présentation PURE : la page (`/agenda/evenements-reference`) lit
 * `GET /api/evenements-reference` et passe la page lue ; chaque changement
 * (recherche, filtre, tri, page) est rendu à la page par `onQuery`. Aucune
 * règle métier ici. Chaque ligne est un vrai lien vers la fiche (clavier,
 * nouvel onglet) ; chaque bien est un vrai lien vers sa page. Aucun intitulé
 * n'est coupé (retour à la ligne). Aucun état interne (envisagé, réalisé,
 * annulé) n'est affiché : décision du PO du 12/11/2026.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Layers, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  OPERATION_LIST_LABELS as L, OPERATION_LIST_SORTS, OPERATION_LIST_STATES, OPERATION_LIST_TYPE_NONE,
  type OperationListItem, type OperationListPage, type OperationListQuery, type OperationListSort, type OperationListState,
} from "@/lib/reference-events/operation-list";
import { referenceEventDay, referenceEventHref } from "@/lib/reference-events/reference-event-page";
import { referenceEventEuros } from "@/lib/reference-events/reference-event-summary";

const SELECT = "h-11 w-full min-w-0 rounded-[12px] border border-input bg-[color:var(--field-bg)] px-3 text-base text-foreground outline-none focus-visible:border-[color:var(--accent)] md:h-9 md:text-sm";
const FIELD = "flex min-w-0 flex-col gap-1 text-xs text-muted-foreground";

function Repere({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Ligne({ item }: { item: OperationListItem }) {
  const montant = referenceEventEuros(item.netCents);
  const fournisseurs = item.suppliers.length ? item.suppliers : item.provider ? [item.provider] : [];
  return (
    <li data-testid={`operation-list-item-${item.id}`} data-operation-id={item.id}>
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            <Layers className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <Link href={referenceEventHref(item.id)} aria-label={L.open(item.title)}
                className="inline-flex min-h-[44px] items-center text-base font-semibold text-[color:var(--text-primary)] hover:underline md:min-h-0 [overflow-wrap:anywhere]">
                {item.title}
              </Link>
              <p className="text-sm text-muted-foreground" data-testid={`operation-list-meta-${item.id}`}>
                {item.typeLabel ?? L.noType} · {referenceEventDay(item.date) ?? L.undated} · {L.documents(item.documentCount)} · {L.events(item.agendaItemCount)}
              </p>
            </div>
            {montant && (
              <div className="shrink-0 text-right" data-testid={`operation-list-amount-${item.id}`}>
                <p className="text-xs text-muted-foreground">{L.colAmount}</p>
                <p className="vb-tabular text-sm font-semibold text-[color:var(--text-primary)]">{montant}</p>
              </div>
            )}
          </div>
          {(item.assets.length > 0 || item.rooms.length > 0 || item.equipments.length > 0 || fournisseurs.length > 0 || item.contracts.length > 0 || item.unconvertedCount > 0) && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              {item.assets.length > 0 && (
                <Repere label={L.colAssets}>
                  {item.assets.map((a, i) => (
                    <span key={a.id}>{i > 0 ? ", " : ""}<Link href={`/assets/${a.id}`} className="text-primary hover:underline">{a.name}</Link></span>
                  ))}
                </Repere>
              )}
              {item.rooms.length > 0 && <Repere label={L.colRooms}>{item.rooms.join(", ")}</Repere>}
              {item.equipments.length > 0 && <Repere label={L.colEquipments}>{item.equipments.join(", ")}</Repere>}
              {fournisseurs.length > 0 && <Repere label={L.colSuppliers}>{fournisseurs.join(", ")}</Repere>}
              {item.contracts.length > 0 && (
                <Repere label={L.colContracts}>
                  {item.contracts.map((c, i) => (
                    <span key={c.id}>{i > 0 ? ", " : ""}<Link href={referenceEventHref(c.id)} className="text-primary hover:underline">{c.label}</Link></span>
                  ))}
                </Repere>
              )}
              {item.unconvertedCount > 0 && <Repere label={L.colAmount}>{L.unconverted(item.unconvertedCount)}</Repere>}
            </dl>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

/** Présentation pure de la liste (rendue côté serveur dans les tests, montée telle quelle dans le navigateur de test). */
export function ReferenceEventListContent({ data, busy = false, onQuery }: {
  data: OperationListPage; busy?: boolean; onQuery: (patch: Partial<OperationListQuery>) => void;
}) {
  const q = data.query;
  const [texte, setTexte] = useState(q.q);
  useEffect(() => { setTexte(q.q); }, [q.q]);
  const filtree = q.q !== "" || q.type !== null || q.assetId !== null || q.state !== "ALL";
  return (
    <div className="space-y-4" data-testid="operation-list" aria-busy={busy}>
      <div>
        <h1 className="vb-app-title">{L.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{L.intro}</p>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-5">
          <form role="search" className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); onQuery({ q: texte, page: 1 }); }}>
            <label className={`${FIELD} flex-1`}>
              <span>{L.search}</span>
              <span className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={texte} onChange={(e) => setTexte(e.target.value)} placeholder={L.searchHint} className="h-11 pl-9 md:h-9" data-testid="operation-list-search" />
              </span>
            </label>
            <Button type="submit" size="sm" className="h-11 self-end md:h-9" data-testid="operation-list-search-submit">{L.search}</Button>
          </form>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={FIELD}>
              <span>{L.filterType}</span>
              <select className={SELECT} value={q.type ?? ""} onChange={(e) => onQuery({ type: e.target.value || null, page: 1 })} data-testid="operation-list-type">
                <option value="">{L.filterTypeAll}</option>
                {data.types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                <option value={OPERATION_LIST_TYPE_NONE}>{L.filterTypeNone}</option>
              </select>
            </label>
            <label className={FIELD}>
              <span>{L.filterAsset}</span>
              <select className={SELECT} value={q.assetId ?? ""} onChange={(e) => onQuery({ assetId: e.target.value ? Number(e.target.value) : null, page: 1 })} data-testid="operation-list-asset">
                <option value="">{L.filterAssetAll}</option>
                {data.assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              <span>{L.filterState}</span>
              <select className={SELECT} value={q.state} onChange={(e) => onQuery({ state: e.target.value as OperationListState, page: 1 })} data-testid="operation-list-state">
                {OPERATION_LIST_STATES.map((s) => <option key={s} value={s}>{L.states[s]}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              <span>{L.sort}</span>
              <select className={SELECT} value={q.sort} onChange={(e) => onQuery({ sort: e.target.value as OperationListSort, page: 1 })} data-testid="operation-list-sort">
                {OPERATION_LIST_SORTS.map((s) => <option key={s} value={s}>{L.sorts[s]}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-[color:var(--text-primary)]" role="status" data-testid="operation-list-count">{L.count(data.total, data.totalAll)}</p>
            {filtree && (
              <Button type="button" variant="ghost" size="sm" className="h-11 md:h-9" data-testid="operation-list-reset"
                onClick={() => onQuery({ q: "", type: null, assetId: null, state: "ALL", page: 1 })}>
                {L.reset}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="operation-list-empty">{data.totalAll === 0 ? L.empty : L.emptyFiltered}</p>
      ) : (
        <ul className="space-y-3" role="list">{data.items.map((i) => <Ligne key={i.id} item={i} />)}</ul>
      )}

      {data.pages > 1 && (
        <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={L.pageOf(data.page, data.pages)} data-testid="operation-list-pages">
          <Button type="button" variant="outline" size="sm" className="h-11 md:h-9" disabled={data.page <= 1 || busy}
            onClick={() => onQuery({ page: data.page - 1 })} data-testid="operation-list-previous">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />{L.previous}
          </Button>
          <p className="text-sm text-muted-foreground" data-testid="operation-list-page">{L.pageOf(data.page, data.pages)}</p>
          <Button type="button" variant="outline" size="sm" className="h-11 md:h-9" disabled={data.page >= data.pages || busy}
            onClick={() => onQuery({ page: data.page + 1 })} data-testid="operation-list-next">
            {L.next}<ChevronRight className="ml-1 h-4 w-4" aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  );
}
