'use client';

/**
 * Fenêtre d'une demande RGPD — création manuelle, consultation, modification,
 * réouverture (CDC BO GDP-007 à GDP-017).
 *
 * L'échéance affichée pendant la saisie est un APERÇU calculé avec la même
 * règle pure que le serveur (`computeDueDate`) ; la valeur enregistrée est
 * toujours celle du serveur, qui ne l'accepte jamais en entrée (GDP-011).
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Lock, RotateCcw } from 'lucide-react';
import { formatDateTime } from '@/lib/admin/format';
import {
  CHANNEL_LABELS, GDPR_CHANNELS, GDPR_RIGHT_TYPES, ORIGIN_LABELS, RIGHT_LABELS, STATUS_LABELS,
  canTransition, computeDueDate, daysRemaining, isIsoDate, parisDateOf,
  type GdprChannel, type GdprRightType, type GdprStatus,
} from '@/services/gdpr/rules';
import { SubjectPicker } from './SubjectPicker';
import { accountLabel, formatIsoDate, subjectLabel, type GdprRequestDetail, type Subject } from './types';

interface FormState {
  subject: Subject | null;
  rightType: GdprRightType;
  channel: GdprChannel;
  receivedDate: string;
  status: GdprStatus;
  internalComment: string;
  result: string;
}

const selectCls = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

function emptyForm(): FormState {
  return {
    subject: null, rightType: 'access', channel: 'email', receivedDate: parisDateOf(new Date()),
    status: 'received', internalComment: '', result: '',
  };
}

function formFrom(r: GdprRequestDetail): FormState {
  return {
    subject: r.userId
      ? { userId: r.userId, email: r.subjectEmail ?? `#${r.userId}`, name: r.subjectName ?? '', accountId: r.accountId, accountName: r.accountName }
      : null,
    rightType: r.rightType, channel: r.channel, receivedDate: r.receivedDate, status: r.status,
    internalComment: r.internalComment ?? '', result: r.result ?? '',
  };
}

export function GdprRequestDialog({
  open, requestId, onClose, onChanged,
}: {
  open: boolean;
  /** null = création manuelle. */
  requestId: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const creating = requestId === null;
  const [detail, setDetail] = useState<GdprRequestDetail | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // ERR-002 : une clé par ouverture de la fenêtre de création.
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const load = async (id: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/gdpr/${id}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      setDetail(data.request);
      setForm(formFrom(data.request));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    if (requestId === null) {
      setDetail(null);
      setForm(emptyForm());
      setIdempotencyKey(typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()));
    } else {
      void load(requestId);
    }
  }, [open, requestId]);

  const editable = creating || (detail?.origin === 'manual' && detail.status !== 'done');
  const today = parisDateOf(new Date());
  const duePreview = useMemo(
    () => (isIsoDate(form.receivedDate) ? computeDueDate(form.receivedDate, form.rightType) : null),
    [form.receivedDate, form.rightType],
  );

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    // En modification, la personne concernée n'est envoyée que si elle a changé.
    const subjectChanged = creating || (form.subject !== null
      && (form.subject.userId !== detail?.userId || form.subject.accountId !== detail?.accountId));
    const payload = {
      ...(subjectChanged ? { userId: form.subject?.userId ?? null, accountId: form.subject?.accountId ?? null } : {}),
      rightType: form.rightType,
      channel: form.channel,
      receivedDate: form.receivedDate,
      status: form.status,
      internalComment: form.internalComment,
      result: form.result,
    };
    try {
      const res = await fetch(creating ? '/api/admin/gdpr' : `/api/admin/gdpr/${requestId}`, {
        method: creating ? 'POST' : 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(creating ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === 'NOTHING_TO_UPDATE') { setNotice('Aucune modification à enregistrer.'); return; }
        throw new Error(data.message || `Erreur ${res.status}`);
      }
      onChanged();
      if (creating) { onClose(); return; }
      // ERR-003 : état relu depuis le serveur.
      setDetail(data.request);
      setForm(formFrom(data.request));
      setNotice(data.dueDateRecomputed ? 'Enregistré. Échéance recalculée.' : 'Enregistré.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reopen = async () => {
    if (!requestId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/gdpr/${requestId}/reopen`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      setDetail(data.request);
      setForm(formFrom(data.request));
      setNotice('Demande rouverte. L’échéance initiale est conservée.');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const statusOptions = GDPR_STATUS_ORDER.filter((s) => creating || !detail || canTransition(detail.status, s));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? 'Nouvelle demande RGPD' : `Demande RGPD #${requestId}`}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'Demande reçue hors application. L’échéance est calculée automatiquement (réception + 1 mois).'
              : detail ? `${ORIGIN_LABELS[detail.origin]} · ${RIGHT_LABELS[detail.rightType]} · ${STATUS_LABELS[detail.status]}` : ' '}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : loadError ? (
            <div className="text-sm text-red-400">
              {loadError}{' '}
              <button type="button" className="underline" onClick={() => requestId && load(requestId)}>Réessayer</button>
            </div>
          ) : (
            <>
              {detail?.origin === 'system' && (
                <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                  <Lock className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    Demande générée par le système : son statut est piloté automatiquement. Elle ne peut être ni
                    modifiée ni annulée depuis le back-office, et un export en échec ne se relance pas d’ici.
                  </p>
                </div>
              )}
              {detail?.origin === 'manual' && detail.status === 'done' && (
                <div className="flex gap-2 rounded-md border p-3 text-sm text-muted-foreground">
                  <Lock className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>Demande traitée : elle est figée. Rouvrez-la pour la corriger.</p>
                </div>
              )}

              {editable ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2 space-y-1.5">
                    <Label>Utilisateur / compte concerné</Label>
                    <SubjectPicker value={form.subject} onChange={(s) => set('subject', s)} />
                    {!creating && !form.subject && detail && (
                      <p className="text-xs text-muted-foreground">Actuel : {subjectLabel(detail)} · {accountLabel(detail)}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="gdpr-right">Type de droit</Label>
                    <select id="gdpr-right" className={selectCls} value={form.rightType} onChange={(e) => set('rightType', e.target.value as GdprRightType)}>
                      {GDPR_RIGHT_TYPES.map((r) => <option key={r} value={r}>{RIGHT_LABELS[r]}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="gdpr-channel">Canal</Label>
                    <select id="gdpr-channel" className={selectCls} value={form.channel} onChange={(e) => set('channel', e.target.value as GdprChannel)}>
                      {GDPR_CHANNELS.filter((c) => c !== 'app').map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="gdpr-received">Date de réception</Label>
                    <Input id="gdpr-received" type="date" max={today} value={form.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Échéance (calculée)</Label>
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      {duePreview ? formatIsoDate(duePreview) : '—'}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="gdpr-status">Statut</Label>
                    <select id="gdpr-status" className={selectCls} value={form.status} onChange={(e) => set('status', e.target.value as GdprStatus)}>
                      {statusOptions.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </select>
                    {form.status === 'done' && (
                      <p className="text-xs text-muted-foreground">Une demande traitée devient figée.</p>
                    )}
                  </div>
                  <div className="sm:col-span-2 space-y-1.5">
                    <Label htmlFor="gdpr-comment">Commentaire interne</Label>
                    <Textarea id="gdpr-comment" rows={3} value={form.internalComment} onChange={(e) => set('internalComment', e.target.value)} placeholder="Jamais visible par l’utilisateur." />
                  </div>
                  <div className="sm:col-span-2 space-y-1.5">
                    <Label htmlFor="gdpr-result">Résultat final (facultatif)</Label>
                    <Textarea id="gdpr-result" rows={2} value={form.result} onChange={(e) => set('result', e.target.value)} />
                  </div>
                </div>
              ) : detail ? (
                <ReadOnly detail={detail} />
              ) : null}

              {detail && editable && <Meta detail={detail} />}
              {error && <p className="text-sm text-red-400">{error}</p>}
              {notice && <p className="text-sm text-emerald-400">{notice}</p>}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fermer</Button>
          {detail?.origin === 'manual' && detail.status === 'done' && (
            <Button variant="outline" onClick={reopen} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1.5" />}
              Rouvrir
            </Button>
          )}
          {editable && !loading && !loadError && (
            <Button onClick={submit} disabled={saving || (creating && !form.subject) || !isIsoDate(form.receivedDate)}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {creating ? 'Créer la demande' : 'Enregistrer'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const GDPR_STATUS_ORDER: GdprStatus[] = ['received', 'in_progress', 'done'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function ReadOnly({ detail }: { detail: GdprRequestDetail }) {
  const days = daysRemaining(detail.dueDate);
  return (
    <dl className="divide-y rounded-md border px-3">
      <Row label="Utilisateur">{subjectLabel(detail)}</Row>
      <Row label="Compte">{accountLabel(detail)}</Row>
      <Row label="Type de droit">{RIGHT_LABELS[detail.rightType]}</Row>
      <Row label="Canal">{CHANNEL_LABELS[detail.channel]}</Row>
      <Row label="Réception">{formatDateTime(detail.receivedAt)}</Row>
      <Row label="Échéance">
        {formatIsoDate(detail.dueDate)}
        {detail.status !== 'done' && ` (${days >= 0 ? `${days} j restant${days > 1 ? 's' : ''}` : `dépassée de ${-days} j`})`}
      </Row>
      <Row label="Statut">{STATUS_LABELS[detail.status]}</Row>
      {detail.processedAt && <Row label="Traitée le">{formatDateTime(detail.processedAt)}</Row>}
      <Row label="Résultat">{detail.result ?? '—'}</Row>
      {detail.lastError && <Row label="Erreur"><span className="text-red-400">{detail.lastError}</span></Row>}
      {detail.origin === 'manual' && <Row label="Commentaire interne">{detail.internalComment ?? '—'}</Row>}
      <MetaRows detail={detail} />
    </dl>
  );
}

function MetaRows({ detail }: { detail: GdprRequestDetail }) {
  return (
    <>
      {detail.createdByEmail && <Row label="Créée par">{detail.createdByEmail}</Row>}
      {detail.reopenedAt && (
        <Row label="Dernière réouverture">
          {formatDateTime(detail.reopenedAt)}{detail.reopenedByEmail ? ` par ${detail.reopenedByEmail}` : ''}
          {detail.reopenCount > 1 ? ` (${detail.reopenCount} réouvertures)` : ''}
        </Row>
      )}
    </>
  );
}

function Meta({ detail }: { detail: GdprRequestDetail }) {
  if (!detail.createdByEmail && !detail.reopenedAt) return null;
  return <dl className="divide-y rounded-md border px-3"><MetaRows detail={detail} /></dl>;
}
