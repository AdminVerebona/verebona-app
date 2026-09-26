"use client";

/**
 * Parrainages & promotions — CDC Back-Office V1 §8.
 *
 * Le parrainage Verebona et les promotions Stripe sont présentés séparément ;
 * aucun total ne mélange les deux. Tri par utilisations et conversions
 * payantes (REF-002), pagination classique sans recherche (REF-003), pas de
 * CA ni de taux de conversion par code (REF-001).
 *
 * Consultation uniquement (§20) : aucune attribution, annulation ou correction
 * d'avantage (REF-009), aucune création ni modification de code promo
 * (PRO-001) — seul « Ouvrir dans Stripe » est proposé pour les promotions.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDate } from '@/lib/admin/format';
import { ExternalLink, Gift, Loader2, RefreshCw } from 'lucide-react';
import { AdminPagination, SortHeader, nextSort } from '../subscriptions/_components/list-controls';

type Sort = 'uses' | 'conversions';

interface Summary {
  referral: { activeCodes: number; totalUses: number; paidConversions: number };
  promotions: { totalUses: number; paidConversions: number };
}

interface PageData<T> { items: T[]; page: number; totalPages: number; total: number }

interface Referrer {
  linkId: number;
  code: string;
  isActive: boolean;
  accountId: number;
  accountName: string;
  uses: number;
  paidConversions: number;
  inProgress: number;
  validated: number;
  rewardsGranted: number;
  rewardsCanceled: number;
}

interface Promotion { id: number; code: string; uses: number; paidConversions: number; stripeUrl: string | null }

interface ReferralEvent {
  id: number;
  referredAccountId: number;
  referredAccountName: string | null;
  statusLabel: string;
  usedAt: string;
  forecastRewardAt: string | null;
  rewardedAt: string | null;
  reward: string | null;
  canceledAt: string | null;
}

interface ReferrerDetail { code: string; accountId: number; accountName: string; events: ReferralEvent[] }
interface PromotionDetail { code: string; stripeUrl: string | null; accounts: Array<{ accountId: number; accountName: string; usedAt: string; paid: boolean }> }

function StripeLink({ href }: { href: string | null }) {
  if (!href) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs underline text-muted-foreground hover:text-foreground">
      Ouvrir dans Stripe <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ReferralsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get('tab') === 'promotions' ? 'promotions' : 'referral';
  const sort: Sort = params.get('sort') === 'conversions' ? 'conversions' : 'uses';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [referrers, setReferrers] = useState<PageData<Referrer> | null>(null);
  const [promotions, setPromotions] = useState<PageData<Promotion> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [referrerDetail, setReferrerDetail] = useState<ReferrerDetail | 'loading' | null>(null);
  const [promotionDetail, setPromotionDetail] = useState<PromotionDetail | 'loading' | null>(null);

  const setQuery = useCallback((next: Record<string, string>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) qs.set(k, v);
    router.replace(`${pathname}?${qs}`);
  }, [params, pathname, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = `sort=${sort}&dir=${dir}&page=${page}`;
      const [refRes, promoRes] = await Promise.all([
        fetch(`/api/admin/referrals?${tab === 'referral' ? qs : 'page=1'}`, { credentials: 'include' }),
        tab === 'promotions' ? fetch(`/api/admin/referrals/promotions?${qs}`, { credentials: 'include' }) : Promise.resolve(null),
      ]);
      const refPayload = await refRes.json().catch(() => ({}));
      if (!refRes.ok) throw new Error(refPayload.message || `Erreur ${refRes.status}`);
      setSummary(refPayload.summary);
      setReferrers(refPayload.referrers);
      if (promoRes) {
        const promoPayload = await promoRes.json().catch(() => ({}));
        if (!promoRes.ok) throw new Error(promoPayload.message || `Erreur ${promoRes.status}`);
        setPromotions(promoPayload);
      }
    } catch (err) {
      setSummary(null);
      setReferrers(null);
      setPromotions(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [tab, sort, dir, page]);

  useEffect(() => { void load(); }, [load]);

  const onSort = (key: Sort) => {
    // Premier clic : décroissant (les plus utilisés d'abord).
    const n = sort === key ? nextSort(sort, dir, key) : { sort: key, dir: 'desc' as const };
    setQuery({ sort: n.sort, dir: n.dir, page: '1' });
  };

  const openReferrer = async (linkId: number) => {
    setReferrerDetail('loading');
    try {
      const res = await fetch(`/api/admin/referrals/${linkId}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setReferrerDetail(payload);
    } catch (err) {
      setReferrerDetail(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  const openPromotion = async (id: number) => {
    setPromotionDetail('loading');
    try {
      const res = await fetch(`/api/admin/referrals/promotions/${id}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setPromotionDetail(payload);
    } catch (err) {
      setPromotionDetail(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Gift className="h-6 w-6" /> Parrainages & promotions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Suivi des codes et des conversions — consultation uniquement.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
        </Button>
      </div>

      {/* §8.1 : deux blocs distincts, aucun total consolidé */}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-semibold mb-1">Parrainage</p>
            <Kpi label="Codes de parrainage actifs" value={summary.referral.activeCodes} />
            <Kpi label="Utilisations" value={summary.referral.totalUses} />
            <Kpi label="Conversions payantes" value={summary.referral.paidConversions} />
          </div>
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm font-semibold mb-1">Promotions Stripe</p>
            <Kpi label="Codes actifs" value="—" />
            <Kpi label="Utilisations" value={summary.promotions.totalUses} />
            <Kpi label="Conversions payantes" value={summary.promotions.paidConversions} />
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b">
        {([['referral', 'Parrainage'], ['promotions', 'Promotions Stripe']] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setQuery({ tab: key, page: '1' })}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === key ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && !referrers ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EcranEnErreur titre="Chargement impossible" message={error} onRetry={() => load()} />
      ) : tab === 'referral' && referrers ? (
        referrers.total === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Aucun code de parrainage.</p>
        ) : (
          <>
            <div className="rounded-xl border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Compte parrain</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right"><SortHeader label="Utilisations" sortKey="uses" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                    <TableHead className="text-right"><SortHeader label="Conversions payantes" sortKey="conversions" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                    <TableHead className="text-right">Filleuls en cours</TableHead>
                    <TableHead className="text-right">Filleuls validés</TableHead>
                    <TableHead className="text-right">Avantages accordés</TableHead>
                    <TableHead className="text-right">Avantages annulés</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referrers.items.map((r) => (
                    <TableRow key={r.linkId} className="cursor-pointer" onClick={() => openReferrer(r.linkId)}>
                      <TableCell>
                        <Link href={`/admin/accounts/${r.accountId}`} onClick={(e) => e.stopPropagation()} className="font-medium text-sm hover:underline">{r.accountName}</Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.code}{!r.isActive && <span className="ml-2 text-muted-foreground">(inactif)</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.uses}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.paidConversions}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.inProgress}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.validated}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.rewardsGranted}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.rewardsCanceled}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <AdminPagination page={referrers.page} totalPages={referrers.totalPages} total={referrers.total} disabled={loading} onPage={(p) => setQuery({ page: String(p) })} />
          </>
        )
      ) : tab === 'promotions' && promotions ? (
        promotions.total === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Aucun code promotionnel. Les codes sont créés et configurés dans Stripe.</p>
        ) : (
          <>
            <div className="rounded-xl border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right"><SortHeader label="Utilisations" sortKey="uses" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                    <TableHead className="text-right"><SortHeader label="Conversions payantes" sortKey="conversions" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                    <TableHead>Stripe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {promotions.items.map((p) => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => openPromotion(p.id)}>
                      <TableCell className="font-mono text-xs">{p.code}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.uses}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.paidConversions}</TableCell>
                      <TableCell><StripeLink href={p.stripeUrl} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <AdminPagination page={promotions.page} totalPages={promotions.totalPages} total={promotions.total} disabled={loading} onPage={(p) => setQuery({ page: String(p) })} />
          </>
        )
      ) : null}

      {/* REF-005 à REF-008 */}
      <Dialog open={!!referrerDetail} onOpenChange={(open) => { if (!open) setReferrerDetail(null); }}>
        <DialogContent className="max-w-4xl">
          {referrerDetail === 'loading' || !referrerDetail ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Parrainages de {referrerDetail.accountName}</DialogTitle>
                <DialogDescription>Code {referrerDetail.code} — consultation uniquement.</DialogDescription>
              </DialogHeader>
              {referrerDetail.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Ce code n’a pas encore été utilisé.</p>
              ) : (
                <div className="overflow-x-auto max-h-[60vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Filleul</TableHead>
                        <TableHead>Utilisation</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead>Attribution prévue</TableHead>
                        <TableHead>Attribution réelle</TableHead>
                        <TableHead>Avantage</TableHead>
                        <TableHead>Annulation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {referrerDetail.events.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell>
                            <Link href={`/admin/accounts/${e.referredAccountId}`} className="text-sm hover:underline">
                              {e.referredAccountName ?? `Compte #${e.referredAccountId}`}
                            </Link>
                          </TableCell>
                          <TableCell className="text-xs">{formatDate(e.usedAt)}</TableCell>
                          <TableCell className="text-sm">{e.statusLabel}</TableCell>
                          <TableCell className="text-xs">{e.forecastRewardAt ? formatDate(e.forecastRewardAt) : e.statusLabel === 'En cours' ? 'Après le 1er paiement' : '—'}</TableCell>
                          <TableCell className="text-xs">{formatDate(e.rewardedAt)}</TableCell>
                          <TableCell className="text-xs">{e.reward ?? '—'}</TableCell>
                          <TableCell className="text-xs">{formatDate(e.canceledAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* PRO-002 : comptes concernés */}
      <Dialog open={!!promotionDetail} onOpenChange={(open) => { if (!open) setPromotionDetail(null); }}>
        <DialogContent className="max-w-2xl">
          {promotionDetail === 'loading' || !promotionDetail ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Code {promotionDetail.code}</DialogTitle>
                <DialogDescription>Comptes ayant utilisé ce code. Paramètres du code : voir Stripe.</DialogDescription>
              </DialogHeader>
              <StripeLink href={promotionDetail.stripeUrl} />
              {promotionDetail.accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun compte n’a utilisé ce code.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Compte</TableHead><TableHead>Utilisation</TableHead><TableHead>Conversion payante</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {promotionDetail.accounts.map((a) => (
                      <TableRow key={a.accountId}>
                        <TableCell><Link href={`/admin/accounts/${a.accountId}`} className="text-sm hover:underline">{a.accountName}</Link></TableCell>
                        <TableCell className="text-xs">{formatDate(a.usedAt)}</TableCell>
                        <TableCell className="text-sm">{a.paid ? 'Oui' : 'Non'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminReferralsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <ReferralsScreen />
    </Suspense>
  );
}
