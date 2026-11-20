"use client";
/**
 * Liste des opérations du compte — `/agenda/evenements-reference` (carte
 * Trello #806, volet B §8).
 *
 * Page sous l'Agenda, SANS entrée de menu (la carte interdit un menu
 * « Opérations ») : on y arrive depuis la fiche d'une opération (« Toutes les
 * opérations »). Elle hérite de la protection de session des pages de
 * l'Agenda ; les droits sont appliqués côté serveur
 * (`GET /api/evenements-reference` : compte actif de la session seulement).
 *
 * La demande (recherche, filtres, tri, page) vit dans l'ADRESSE : elle se
 * partage, se retrouve au retour depuis une fiche, et le bouton « Retour » du
 * navigateur la rend telle qu'elle était. Lecture seule : aucune écriture.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useBreadcrumb } from "@/contexts/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  OPERATION_LIST_LABELS as L, operationListQueryOf, operationListSearchParams,
  type OperationListPage, type OperationListQuery,
} from "@/lib/reference-events/operation-list";
import { ReferenceEventListContent } from "@/components/reference-events/ReferenceEventList";

const AGENDA_ROUTE = "/agenda";

function Liste() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumb();
  const query = useMemo(() => operationListQueryOf(params), [params]);
  const cle = operationListSearchParams(query);
  const [data, setData] = useState<OperationListPage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/evenements-reference${cle ? `?${cle}` : ""}`, { credentials: "include", signal });
      if (!res.ok) { setState("error"); return; }
      setData((await res.json()) as OperationListPage);
      setState("ready");
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") setState("error");
    } finally {
      setBusy(false);
    }
  }, [cle]);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  useEffect(() => { setBreadcrumbs([{ label: "Mon agenda", href: AGENDA_ROUTE }, { label: L.title }]); }, [setBreadcrumbs]);

  const onQuery = useCallback((patch: Partial<OperationListQuery>) => {
    const suite = operationListSearchParams({ ...query, ...patch });
    router.push(suite ? `${pathname}?${suite}` : pathname, { scroll: false });
  }, [pathname, query, router]);

  const retour = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(AGENDA_ROUTE);
  }, [router]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Button variant="ghost" size="sm" className="-ml-2 h-11 px-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] md:h-9" onClick={retour} data-testid="operation-list-back">
        <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />{L.back}
      </Button>
      {state === "error" ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6" data-testid="operation-list-unavailable">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="font-medium">{L.loadError}</p>
            <Button size="sm" className="h-11 md:h-9" onClick={() => { setState("loading"); void load(); }}>{L.retry}</Button>
          </CardContent>
        </Card>
      ) : data ? (
        <ReferenceEventListContent data={data} busy={busy} onQuery={onQuery} />
      ) : (
        <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>
      )}
    </div>
  );
}

export default function ReferenceEventListPage() {
  // `useSearchParams` exige une frontière de suspension (rendu statique de la coquille).
  return <Suspense fallback={<div className="space-y-4 p-4 md:p-6"><Skeleton className="h-10 w-72" /><Skeleton className="h-40" /></div>}><Liste /></Suspense>;
}
