'use client';

/**
 * Administration des rétractations — CDC 6 §16, §17, §18 et §22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CET ÉCRAN NE PERMET PAS DE CORRIGER UNE DÉCLARATION
 *
 * Ni le contenu, ni l'horodatage, ni les instantanés. Une déclaration de
 * rétractation est un acte juridique unilatéral : elle ne se corrige pas.
 * Le déclencheur de la migration 0117 l'interdirait de toute façon, mais
 * l'interface ne doit pas même le suggérer.
 *
 * Ce qu'elle permet : relancer un traitement bloqué, consigner un
 * remboursement effectué hors Stripe, passer une demande en examen, la
 * rejeter avec motif. Chacune de ces actions écrit un événement de plus au
 * journal — jamais une réécriture (§18).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FileMinus, Loader2, AlertTriangle, RefreshCw, MessageSquarePlus, Banknote, Ban, Eye,
} from 'lucide-react';

interface Item {
  publicReference: string;
  status: string;
  channel: string;
  requestedAt: string;
  consumerName: string;
  accountId: number | null;
  cancellationStatus: string;
  amountExpected: number | null;
  amountRefunded: number;
  failureCode: string | null;
  needsAttention: boolean;
}

interface EventRow {
  id: number;
  occurredAt: string;
  eventType: string;
  actor: string;
  result: string;
  summary: string;
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  received: { label: 'Reçue', className: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  manual_review: { label: 'À examiner', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  processing: { label: 'En traitement', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  completed: { label: 'Traitée', className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  failed: { label: 'En échec', className: 'bg-red-500/15 text-red-300 border-red-500/30' },
  rejected: { label: 'Non retenue', className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
};

const EVENT_LABELS: Record<string, string> = {
  JOURNEY_VIEWED: 'Parcours affiché',
  DECLARATION_RECEIVED: 'Déclaration reçue',
  RECEIPT_SENT: 'Accusé de réception',
  SUBSCRIPTION_CANCELLED: 'Abonnement annulé',
  SUBSCRIPTION_CANCEL_FAILED: 'Annulation refusée',
  PAYMENTS_IDENTIFIED: 'Paiements identifiés',
  REFUND_REQUESTED: 'Remboursement demandé',
  REFUND_STATUS_CHANGED: 'Statut de remboursement',
  WEBHOOK_RECEIVED: 'Webhook reçu',
  EXPORT_ONLY_ENTERED: 'Passage en export seul',
  DELETION_SCHEDULED: 'Suppression planifiée',
  DELETION_EXECUTED: 'Suppression exécutée',
  DELETION_CANCELLED: 'Suppression annulée',
  ADMIN_NOTE: 'Note',
  ADMIN_RETRY: 'Relance manuelle',
  ADMIN_MANUAL_REFUND: 'Remboursement hors Stripe',
  ADMIN_STATUS_CHANGED: 'Statut modifié',
  ADMIN_REJECTED: 'Demande non retenue',
};

const euros = (c: number | null) =>
  c === null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(c / 100);

const paris = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(iso));

export default function AdminWithdrawalsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [byStatus, setByStatus] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/withdrawals', { credentials: 'include' });
    if (!r.ok) { setError('Chargement impossible.'); setLoading(false); return; }
    const data = await r.json();
    setItems(data.items ?? []);
    setByStatus(data.byStatus ?? {});
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (reference: string) => {
    setSelected(reference);
    setEvents([]);
    setReason('');
    setAmount('');
    const r = await fetch(`/api/admin/withdrawals/${reference}`, { credentials: 'include' });
    if (r.ok) setEvents((await r.json()).events ?? []);
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/admin/withdrawals/${selected}/actions`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason, ...extra }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Action refusée.'); return; }
      await load();
      await openDetail(selected);
    } finally { setBusy(false); }
  };

  const attention = items.filter((i) => i.needsAttention).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <FileMinus className="w-7 h-7" />
          Rétractations
        </h1>
        <p className="text-muted-foreground mt-1">
          Demandes, traitement Stripe et journal de preuve.
        </p>
      </div>

      {attention > 0 && (
        <div className="rounded-md bg-amber-500/10 text-amber-300 text-sm p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {attention} demande{attention > 1 ? 's' : ''} appelle
            {attention > 1 ? 'nt' : ''} une intervention : examen manuel, échec de
            traitement, ou attente de plus de vingt-quatre heures.
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3">{error}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {Object.entries(byStatus).map(([status, count]) => (
          <Badge key={status} variant="outline" className={STATUS_STYLES[status]?.className}>
            {STATUS_STYLES[status]?.label ?? status} : {count}
          </Badge>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>Demandes</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune demande enregistrée.</p>
          ) : (
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {items.map((item) => (
                <li key={item.publicReference} className="py-3 flex flex-wrap items-center gap-3">
                  {item.needsAttention && (
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  )}
                  <span className="font-mono text-sm">{item.publicReference}</span>
                  <Badge variant="outline" className={STATUS_STYLES[item.status]?.className}>
                    {STATUS_STYLES[item.status]?.label ?? item.status}
                  </Badge>
                  <span className="text-sm">{item.consumerName || '—'}</span>
                  <span className="text-xs text-muted-foreground">{paris(item.requestedAt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {euros(item.amountRefunded)} / {euros(item.amountExpected)}
                  </span>
                  {item.failureCode && (
                    <span className="text-xs font-mono text-destructive">{item.failureCode}</span>
                  )}
                  <Button
                    size="sm" variant="outline" className="ml-auto"
                    onClick={() => openDetail(item.publicReference)}
                  >
                    <Eye className="w-3.5 h-3.5 mr-1" />
                    Détail
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-base">{selected}</CardTitle>
            <CardDescription>
              Journal de preuve — en ajout seul. Une correction s&apos;écrit comme un
              événement de plus, jamais comme une réécriture.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ol className="space-y-1 text-xs">
              {events.map((e) => (
                <li key={e.id} className={e.result === 'failure' ? 'text-destructive' : 'text-muted-foreground'}>
                  <span className="font-mono">{paris(e.occurredAt)}</span>
                  {' · '}
                  <span className="font-medium">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                  {' · '}
                  <span className="font-mono">{e.actor}</span>
                  {' — '}
                  {e.summary}
                </li>
              ))}
              {events.length === 0 && <li className="text-muted-foreground">Aucun événement.</li>}
            </ol>

            <div className="space-y-3 border-t border-[color:var(--border-subtle)] pt-4">
              <div className="space-y-1.5">
                <Label htmlFor="reason">Motif</Label>
                <Input
                  id="reason" value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Consigné au journal. Obligatoire hors relance."
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => act('retry')} disabled={busy}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                  Relancer le traitement
                </Button>
                <Button size="sm" variant="outline" onClick={() => act('note')} disabled={busy || !reason}>
                  <MessageSquarePlus className="w-3.5 h-3.5 mr-1" />
                  Ajouter une note
                </Button>
                <Button size="sm" variant="outline" onClick={() => act('force_review')} disabled={busy || !reason}>
                  Passer en examen
                </Button>
                <Button size="sm" variant="outline" onClick={() => act('reject')} disabled={busy || !reason}>
                  <Ban className="w-3.5 h-3.5 mr-1" />
                  Ne pas retenir
                </Button>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="amount">Remboursement hors Stripe (centimes)</Label>
                  <Input
                    id="amount" value={amount} onChange={(e) => setAmount(e.target.value)}
                    placeholder="5900" className="w-40"
                  />
                </div>
                <Button
                  size="sm" variant="outline" disabled={busy || !reason || !amount}
                  onClick={() => act('manual_refund', { amount: Number(amount) })}
                >
                  <Banknote className="w-3.5 h-3.5 mr-1" />
                  Consigner le remboursement
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Cette action ne rembourse pas : elle consigne un virement ou un
                chèque déjà effectué, comme le prévoit la voie alternative du §17.3.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
