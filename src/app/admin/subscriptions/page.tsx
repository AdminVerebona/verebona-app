"use client";

/**
 * Abonnements & paiements — CDC Back-Office V1 §7.
 *
 * Vue transverse de diagnostic : synthèse (SUB-001), liste triable et paginée
 * (SUB-003, SUB-007, SUB-008) liée à la fiche Compte, historique des
 * paiements (SUB-009, SUB-010) et liens « Ouvrir dans Stripe » (SUB-011).
 * Aucune action financière (§7.4) : les opérations se font dans Stripe ; le
 * changement exceptionnel d'offre est sur la fiche Compte (SUB-014).
 * Pas de MRR (SUB-002), de montant de renouvellement (SUB-004), de moyen de
 * paiement (SUB-005), de recherche (SUB-006), d'identifiant Stripe (SUB-012)
 * ni de facture (SUB-013).
 *
 * Tri, sens, page et onglet sont portés par l'URL : ils sont conservés au
 * retour depuis une fiche Compte (UX-004).
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDate, formatDateTime, formatMoney } from '@/lib/admin/format';
import { CreditCard, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { AdminPagination, SortHeader, nextSort } from './_components/list-controls';

type Sort = 'plan' | 'status' | 'period' | 'payment' | 'renewal' | 'end';

interface Summary { active: number; trials: number; scheduledEnds: number; failedPayments: number }

interface SubscriptionItem {
  accountId: number;
  accountName: string;
  ownerEmail: string | null;
  planLabel: string;
  status: string;
  statusLabel: string;
  billingPeriod: string | null;
  paymentStatus: 'failed' | 'up_to_date' | 'none';
  paymentStatusLabel: string;
  nextRenewalAt: string | null;
  scheduledEndAt: string | null;
  stripeUrl: string | null;
}

interface PaymentItem {
  id: number;
  date: string;
  amountCents: number;
  currency: string;
  status: 'paid' | 'failed' | 'pending' | 'void';
  statusLabel: string;
  accountId: number;
  accountName: string;
  plan: string;
  stripeUrl: string | null;
}

interface PageData<T> { items: T[]; page: number; totalPages: number; total: number }

const PERIOD_LABELS: Record<string, string> = { monthly: 'Mensuelle', yearly: 'Annuelle' };
const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard', PREMIUM: 'Premium', PREMIUM_DUO: 'Premium Duo', PREMIUM_PRO: 'Premium Pro',
  standard: 'Standard', premium: 'Premium', premium_duo: 'Premium Duo', premium_pro: 'Premium Pro',
};

const PAYMENT_CLS: Record<string, string> = {
  failed: 'text-red-500', up_to_date: 'text-emerald-500', none: 'text-muted-foreground',
  paid: 'text-emerald-500', pending: 'text-amber-500', void: 'text-muted-foreground',
};

function StripeLink({ href }: { href: string | null }) {
  if (!href) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs underline text-muted-foreground hover:text-foreground"
    >
      Ouvrir dans Stripe <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function SubscriptionsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get('tab') === 'payments' ? 'payments' : 'subscriptions';
  const sort = (params.get('sort') as Sort) || 'renewal';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [subs, setSubs] = useState<PageData<SubscriptionItem> | null>(null);
  const [payments, setPayments] = useState<PageData<PaymentItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setQuery = useCallback((next: Record<string, string>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) qs.set(k, v);
    router.replace(`${pathname}?${qs}`);
  }, [params, pathname, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = tab === 'payments'
        ? `/api/admin/subscriptions/payments?page=${page}`
        : `/api/admin/subscriptions?sort=${sort}&dir=${dir}&page=${page}`;
      const res = await fetch(url, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      if (tab === 'payments') {
        setPayments(payload);
      } else {
        setSummary(payload.summary);
        setSubs(payload);
      }
    } catch (err) {
      // ERR-001 : aucune donnée partielle affichée comme complète.
      setSubs(null);
      setPayments(null);
      setSummary(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [tab, sort, dir, page]);

  useEffect(() => { void load(); }, [load]);

  const onSort = (key: Sort) => {
    const n = nextSort(sort, dir, key);
    setQuery({ sort: n.sort, dir: n.dir, page: '1' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="h-6 w-6" />
            Abonnements & paiements
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Consultation et diagnostic — les opérations financières se font dans Stripe.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* SUB-001 */}
      {tab === 'subscriptions' && summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Abonnements actifs', value: summary.active, cls: 'text-emerald-500' },
            { label: 'Essais en cours', value: summary.trials, cls: 'text-blue-500' },
            { label: 'Fins programmées', value: summary.scheduledEnds, cls: 'text-amber-500' },
            { label: 'Paiements échoués', value: summary.failedPayments, cls: 'text-red-500' },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border bg-card p-4 text-center">
              <p className={`text-2xl font-bold ${k.cls}`}>{k.value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 border-b">
        {([['subscriptions', 'Abonnements'], ['payments', 'Paiements']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setQuery({ tab: key, page: '1' })}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === key ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !(tab === 'payments' ? payments : subs) ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EcranEnErreur titre="Chargement impossible" message={error} onRetry={() => load()} />
      ) : tab === 'subscriptions' && subs ? (
        subs.total === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Aucun abonnement.</p>
        ) : (
          <>
            <div className="rounded-xl border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Compte</TableHead>
                    <TableHead><SortHeader label="Offre" sortKey="plan" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead><SortHeader label="Statut" sortKey="status" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead><SortHeader label="Périodicité" sortKey="period" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead><SortHeader label="Paiement" sortKey="payment" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead><SortHeader label="Prochaine échéance" sortKey="renewal" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead><SortHeader label="Fin programmée" sortKey="end" current={sort} dir={dir} onSort={onSort} /></TableHead>
                    <TableHead>Stripe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subs.items.map((s) => (
                    <TableRow key={s.accountId} className="cursor-pointer" onClick={() => router.push(`/admin/accounts/${s.accountId}`)}>
                      <TableCell>
                        <Link href={`/admin/accounts/${s.accountId}`} className="font-medium text-sm hover:underline" onClick={(e) => e.stopPropagation()}>
                          {s.accountName}
                        </Link>
                        {s.ownerEmail && <div className="text-xs text-muted-foreground truncate max-w-[16rem]">{s.ownerEmail}</div>}
                      </TableCell>
                      <TableCell className="text-sm">{PLAN_LABELS[s.planLabel] ?? s.planLabel}</TableCell>
                      <TableCell className="text-sm">{s.statusLabel}</TableCell>
                      <TableCell className="text-sm">{s.billingPeriod ? PERIOD_LABELS[s.billingPeriod] ?? s.billingPeriod : '—'}</TableCell>
                      <TableCell className={`text-sm font-medium ${PAYMENT_CLS[s.paymentStatus]}`}>{s.paymentStatusLabel}</TableCell>
                      <TableCell className="text-xs">{formatDate(s.nextRenewalAt)}</TableCell>
                      <TableCell className="text-xs">{formatDate(s.scheduledEndAt)}</TableCell>
                      <TableCell><StripeLink href={s.stripeUrl} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <AdminPagination page={subs.page} totalPages={subs.totalPages} total={subs.total} disabled={loading} onPage={(p) => setQuery({ page: String(p) })} />
          </>
        )
      ) : tab === 'payments' && payments ? (
        payments.total === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Aucun paiement enregistré.</p>
        ) : (
          <>
            <div className="rounded-xl border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Montant</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Compte</TableHead>
                    <TableHead>Offre</TableHead>
                    <TableHead>Stripe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.items.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs">{formatDateTime(p.date)}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{formatMoney(p.amountCents, p.currency)}</TableCell>
                      <TableCell className={`text-sm font-medium ${PAYMENT_CLS[p.status]}`}>{p.statusLabel}</TableCell>
                      <TableCell>
                        <Link href={`/admin/accounts/${p.accountId}`} className="text-sm hover:underline">{p.accountName}</Link>
                      </TableCell>
                      <TableCell className="text-sm">{PLAN_LABELS[p.plan] ?? p.plan}</TableCell>
                      <TableCell><StripeLink href={p.stripeUrl} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <AdminPagination page={payments.page} totalPages={payments.totalPages} total={payments.total} disabled={loading} onPage={(p) => setQuery({ page: String(p) })} />
          </>
        )
      ) : null}
    </div>
  );
}

export default function AdminSubscriptionsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <SubscriptionsScreen />
    </Suspense>
  );
}
