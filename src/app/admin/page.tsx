"use client";

/**
 * Dashboard back-office — CDC Back-Office V1 §4.
 *
 * DASH-001 / DASH-002 : quatre sous-onglets, « Vue d'ensemble » par défaut.
 * DASH-003 : les trois vues de pilotage partagent le sélecteur de période
 * (Mois par défaut) ; la Supervision n'en a pas (état actuel).
 *
 * Onglet, période, tri et pages vivent dans l'URL (`?tab=&period=&ref=…`) :
 * un lien partagé ou un retour arrière retrouve le même écran (UX-004).
 *
 * L'ancien tableau de bord (derniers inscrits, derniers audits, état des
 * sauvegardes) est retiré : GEN-005 (pas de duplication), AUD-002 (pas
 * d'écran de journal) ; les sauvegardes sont absorbées dans la Supervision
 * (§15).
 */
import { Suspense, useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LayoutDashboard } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parsePeriodKind, parseRef, resolvePeriod, type PeriodKind } from '@/lib/admin/periods';
import { PeriodSelector } from './_dashboard/PeriodSelector';
import { OverviewTab } from './_dashboard/OverviewTab';
import { ActivityTab } from './_dashboard/ActivityTab';
import { CommercialTab } from './_dashboard/CommercialTab';
import { SupervisionTab, type ListParams } from './_dashboard/SupervisionTab';
import { VIZ_STYLE } from './_dashboard/charts';

const TABS = [
  { key: 'overview', label: 'Vue d\'ensemble' },
  { key: 'activity', label: 'Activité' },
  { key: 'commercial', label: 'Performance commerciale' },
  { key: 'supervision', label: 'Supervision' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const SORTS = ['date', 'detected', 'domain', 'account', 'user'] as const;

function readList(sp: URLSearchParams, prefix: 'o' | 'h'): ListParams {
  const sort = sp.get(`${prefix}sort`);
  const dir = sp.get(`${prefix}dir`);
  return {
    sort: (SORTS as readonly string[]).includes(sort ?? '') ? (sort as ListParams['sort']) : 'date',
    dir: dir === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, Number(sp.get(`${prefix}page`) ?? 1) || 1),
  };
}

function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const tab: TabKey = (TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab') : 'overview') as TabKey;
  const kind: PeriodKind = parsePeriodKind(sp.get('period'));
  // Même résolution que le serveur (module pur) : libellé et navigation
  // sans requête supplémentaire. Période future → période en cours.
  const period = useMemo(() => {
    const now = new Date();
    const p = resolvePeriod(kind, parseRef(sp.get('ref'), now), now);
    return p.future ? resolvePeriod(kind, parseRef(null, now), now) : p;
  }, [kind, sp]);
  const query = `period=${kind}&ref=${period.ref}`;

  const update = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [sp, router, pathname]);

  const listChange = (prefix: 'o' | 'h') => (p: ListParams) =>
    update({ [`${prefix}sort`]: p.sort, [`${prefix}dir`]: p.dir, [`${prefix}page`]: String(p.page) });

  return (
    <div className="space-y-6">
      <style>{VIZ_STYLE}</style>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <LayoutDashboard className="h-6 w-6" />
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pilotage, activité, performance commerciale et supervision
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => update({ tab: v === 'overview' ? null : v })}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="flex-wrap h-auto">
            {TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
          </TabsList>
          {tab !== 'supervision' && (
            <PeriodSelector
              kind={kind}
              period={period}
              onChange={(k, r) => update({ period: k === 'month' ? null : k, ref: r })}
            />
          )}
        </div>

        {/* Chaque vue n'est montée que lorsqu'elle est affichée : pas de
            requêtes pour les onglets fermés. */}
        <TabsContent value="overview" className="pt-4">{tab === 'overview' && <OverviewTab query={query} />}</TabsContent>
        <TabsContent value="activity" className="pt-4">{tab === 'activity' && <ActivityTab query={query} />}</TabsContent>
        <TabsContent value="commercial" className="pt-4">{tab === 'commercial' && <CommercialTab query={query} />}</TabsContent>
        <TabsContent value="supervision" className="pt-4">
          {tab === 'supervision' && (
            <SupervisionTab
              open={readList(sp, 'o')}
              history={readList(sp, 'h')}
              onOpenChange={listChange('o')}
              onHistoryChange={listChange('h')}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}
