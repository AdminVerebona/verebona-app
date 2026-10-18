"use client";

/**
 * Détail d'une Opération — BO diagnostic (lot 47A, O9 — CDC Opérations V1
 * ch. 21, C26.1). Lecture seule : aucune action (INV-032, F-182, Q9).
 * Desktop et mobile : `OperationDetailView` (sections empilées, tableaux
 * défilants).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Layers, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import type { OperationDetail } from '@/services/business-operations/diagnostics/service';
import { OperationDetailView, OperationStateBadge } from '../_components/views';

export default function AdminOperationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<OperationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/operations/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) { router.push(`/login?returnUrl=/admin/operations/${id}`); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `Erreur ${res.status}`);
      setData(body as OperationDetail);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Erreur réseau.');
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { void load(); }, [load]);

  const op = data?.operation;
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <Link href={op ? `/admin/operations?accountId=${op.accountId}` : '/admin/operations'} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> {op ? `Opérations du compte #${op.accountId}` : 'Opérations'}
          </Link>
          <h1 className="vb-app-title flex flex-wrap items-center gap-2 mt-1">
            <Layers className="h-6 w-6" />
            Opération #{id}
            {op && <span className="text-base font-normal text-muted-foreground">{op.typeLabel}</span>}
            {op && <OperationStateBadge op={op} />}
          </h1>
          {op?.label && <p className="text-sm text-muted-foreground mt-0.5 break-words">{op.label}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
        </Button>
      </div>
      {error ? <EcranEnErreur titre="Chargement de l’Opération impossible" message={error} onRetry={load} />
        : !data ? <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
          : <OperationDetailView d={data} />}
    </div>
  );
}
