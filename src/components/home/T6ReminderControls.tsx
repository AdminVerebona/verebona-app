'use client';

/**
 * Rappels T6 de l'accueil — lot 60 (« Me le rappeler plus tard », « Ne plus
 * me rappeler »). Même composant sur desktop et mobile ; composants et
 * jetons existants uniquement (Dialog, DatePicker, RadioGroup, Button).
 *
 *   · `T6ReminderActions` : deux commandes discrètes sous une carte T6 de
 *     l'accueil — elles visent TOUJOURS l'échéance de cette carte ;
 *   · `T6ReminderSettings` : l'état et les mêmes commandes dans le détail de
 *     l'échéance (agenda), pour modifier ou annuler un choix.
 *
 * Préférence PERSONNELLE : l'échéance, ses documents et l'agenda restent
 * intacts ; dans un compte Duo, l'autre membre garde ses propres rappels.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BellOff, BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import type { MascotReminderRef } from '@/services/home/mascot/types';

const ROUTE = '/api/home/mascot/reminders';

export interface T6ReminderPrefView { scope: 'OCCURRENCE' | 'SERIES'; decision: 'SNOOZED' | 'DISMISSED'; remindAt: string | null; updatedAt: string }
export interface T6ReminderStateView {
  agendaItemId: number; hasSeries: boolean; suggestedDate: string;
  occurrence: T6ReminderPrefView | null; series: T6ReminderPrefView | null;
}

/** « 12 novembre 2026 » (date civile, sans fuseau). */
export function reminderDateLabel(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Demain (AAAA-MM-JJ, heure locale) : borne basse du report. */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Libellé de l'état courant (pur) : le refus de série l'emporte, puis le refus, puis le report. */
export function reminderStatusLabel(s: Pick<T6ReminderStateView, 'occurrence' | 'series'> | null): string {
  if (!s) return '…';
  if (s.series?.decision === 'DISMISSED') return 'Désactivés pour toutes les échéances de cette série';
  if (s.occurrence?.decision === 'DISMISSED') return 'Désactivés pour cette échéance';
  if (s.occurrence?.decision === 'SNOOZED' && s.occurrence.remindAt) return `Reportés au ${reminderDateLabel(s.occurrence.remindAt)}`;
  return 'Actifs : Verebona vous sollicite seulement si une démarche est utile';
}

type Done = 'snoozed' | 'dismissed' | 'cleared';

async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<T6ReminderStateView> {
  const r = method === 'POST'
    ? await apiClient.post<T6ReminderStateView>(ROUTE, body)
    : await apiClient.delete<T6ReminderStateView>(ROUTE, { body: JSON.stringify(body) });
  apiClient.invalidateCache(`${ROUTE}?agendaItemId=${body.agendaItemId}`);
  return r;
}

const message = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;

/** Fenêtre « Me le rappeler plus tard » : date proposée, modifiable. */
function SnoozeDialog({ open, onOpenChange, suggestedDate, subject, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; suggestedDate: string; subject: string;
  onConfirm: (day: string) => Promise<void>;
}) {
  const [day, setDay] = useState(suggestedDate);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setDay(suggestedDate); }, [open, suggestedDate]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="t6-snooze-dialog">
        <DialogHeader>
          <DialogTitle>Me le rappeler plus tard</DialogTitle>
          <DialogDescription>{subject} — je vous le rappellerai à cette date, si c’est toujours utile.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="t6-snooze-date" className="text-xs text-[color:var(--text-muted)]">Date du rappel</Label>
          <DatePicker id="t6-snooze-date" value={day} min={tomorrow()} onChange={setDay} />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button
            disabled={busy || !day}
            onClick={async () => { setBusy(true); try { await onConfirm(day); onOpenChange(false); } finally { setBusy(false); } }}
          >
            Me le rappeler le {day ? reminderDateLabel(day) : '…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fenêtre « Ne plus me rappeler » : cette échéance, ou toute la série (récurrente). */
function DismissDialog({ open, onOpenChange, hasSeries, subject, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; hasSeries: boolean; subject: string;
  onConfirm: (scope: 'OCCURRENCE' | 'SERIES') => Promise<void>;
}) {
  const [scope, setScope] = useState<'OCCURRENCE' | 'SERIES'>('OCCURRENCE');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setScope('OCCURRENCE'); }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="t6-dismiss-dialog">
        <DialogHeader>
          <DialogTitle>Ne plus me rappeler</DialogTitle>
          <DialogDescription>{subject} — l’échéance et ses documents restent dans l’agenda ; seul le rappel sur l’accueil s’arrête.</DialogDescription>
        </DialogHeader>
        {hasSeries && (
          <RadioGroup value={scope} onValueChange={(v) => setScope(v === 'SERIES' ? 'SERIES' : 'OCCURRENCE')} className="gap-3">
            <div className="flex items-start gap-2.5">
              <RadioGroupItem value="OCCURRENCE" id="t6-dismiss-occ" className="mt-0.5" />
              <Label htmlFor="t6-dismiss-occ" className="text-sm font-normal leading-snug">Cette échéance seulement</Label>
            </div>
            <div className="flex items-start gap-2.5">
              <RadioGroupItem value="SERIES" id="t6-dismiss-series" className="mt-0.5" />
              <Label htmlFor="t6-dismiss-series" className="text-sm font-normal leading-snug">Cette échéance et les prochaines de la même série</Label>
            </div>
          </RadioGroup>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(hasSeries ? scope : 'OCCURRENCE'); onOpenChange(false); } finally { setBusy(false); } }}
          >
            Ne plus me rappeler
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LINK = 'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-[color:var(--text-muted)] transition-colors duration-150 hover:text-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]';

/**
 * Commandes de rappel d'une carte T6 de l'accueil. `subject` : intitulé de la
 * carte (affiché dans la fenêtre : on sait toujours QUELLE échéance est visée).
 */
export function T6ReminderActions({ reminder, subject, onDone }: {
  reminder: MascotReminderRef; subject: string; onDone: (kind: Done) => void;
}) {
  const [snooze, setSnooze] = useState(false);
  const [dismiss, setDismiss] = useState(false);

  const annuler = (scope: 'OCCURRENCE' | 'SERIES') => async () => {
    try {
      await send('DELETE', { agendaItemId: reminder.agendaItemId, scope });
      onDone('cleared');
    } catch (e) {
      toast.error(message(e, 'Le rappel n’a pas pu être rétabli.'));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1" data-t6-reminder={reminder.agendaItemId}>
      <button type="button" className={LINK} onClick={() => setSnooze(true)}>
        <BellRing className="h-3.5 w-3.5" aria-hidden /> Me le rappeler plus tard
      </button>
      <button type="button" className={LINK} onClick={() => setDismiss(true)}>
        <BellOff className="h-3.5 w-3.5" aria-hidden /> Ne plus me rappeler
      </button>
      <SnoozeDialog
        open={snooze} onOpenChange={setSnooze} suggestedDate={reminder.suggestedDate} subject={subject}
        onConfirm={async (day) => {
          try {
            await send('POST', { agendaItemId: reminder.agendaItemId, action: 'SNOOZE', remindAt: day });
          } catch (e) {
            toast.error(message(e, 'Votre choix n’a pas pu être enregistré. Réessayez.'));
            return;
          }
          onDone('snoozed');
          toast.success(`C’est noté : je vous le rappellerai le ${reminderDateLabel(day)}.`, {
            duration: 8_000, action: { label: 'Annuler', onClick: () => { void annuler('OCCURRENCE')(); } },
          });
        }}
      />
      <DismissDialog
        open={dismiss} onOpenChange={setDismiss} hasSeries={reminder.hasSeries} subject={subject}
        onConfirm={async (scope) => {
          try {
            await send('POST', { agendaItemId: reminder.agendaItemId, action: 'DISMISS', scope });
          } catch (e) {
            toast.error(message(e, 'Votre choix n’a pas pu être enregistré. Réessayez.'));
            return;
          }
          onDone('dismissed');
          toast.success('C’est noté : je ne vous le rappellerai plus. L’échéance reste dans l’agenda.', {
            duration: 8_000, action: { label: 'Annuler', onClick: () => { void annuler(scope)(); } },
          });
        }}
      />
    </div>
  );
}

/**
 * Rappels de l'accueil dans le détail d'une échéance (agenda) : état courant
 * et commandes pour le modifier — même ligne que « Statut ».
 */
export function T6ReminderSettings({ agendaItemId, title }: { agendaItemId: number; title: string }) {
  const [state, setState] = useState<T6ReminderStateView | null>(null);
  const [failed, setFailed] = useState(false);
  const [snooze, setSnooze] = useState(false);
  const [dismiss, setDismiss] = useState(false);

  const load = useCallback(async () => {
    try {
      apiClient.invalidateCache(`${ROUTE}?agendaItemId=${agendaItemId}`);
      setState(await apiClient.get<T6ReminderStateView>(`${ROUTE}?agendaItemId=${agendaItemId}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [agendaItemId]);
  useEffect(() => { void load(); }, [load]);

  const apply = async (method: 'POST' | 'DELETE', body: Record<string, unknown>, ok: string) => {
    try {
      setState(await send(method, { agendaItemId, ...body }));
      window.dispatchEvent(new CustomEvent('verebona:data-mutated'));
      toast.success(ok);
    } catch (e) {
      toast.error(message(e, 'Votre choix n’a pas pu être enregistré. Réessayez.'));
    }
  };

  if (failed) return null;
  const actif = !state?.occurrence && !state?.series;
  return (
    <div className="flex items-start gap-3" data-testid="t6-reminder-settings">
      <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0 mt-0.5">
        {actif ? <BellRing className="h-4 w-4 text-[color:var(--text-muted)]" /> : <BellOff className="h-4 w-4 text-[color:var(--text-muted)]" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-1">Rappels sur l’accueil</p>
        <p className="text-sm text-[color:var(--text-primary)]">{reminderStatusLabel(state)}</p>
        {state && (
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 -ml-2">
            {state.occurrence?.decision !== 'SNOOZED' && state.series?.decision !== 'DISMISSED' && state.occurrence?.decision !== 'DISMISSED' && (
              <button type="button" className={LINK} onClick={() => setSnooze(true)}>Me le rappeler plus tard</button>
            )}
            {state.occurrence?.decision === 'SNOOZED' && (
              <button type="button" className={LINK} onClick={() => setSnooze(true)}>Changer la date</button>
            )}
            {state.occurrence?.decision !== 'DISMISSED' && state.series?.decision !== 'DISMISSED' && (
              <button type="button" className={LINK} onClick={() => setDismiss(true)}>Ne plus me rappeler</button>
            )}
            {state.occurrence && (
              <button type="button" className={LINK} onClick={() => void apply('DELETE', { scope: 'OCCURRENCE' }, 'Rappels rétablis pour cette échéance.')}>
                Réactiver les rappels
              </button>
            )}
            {state.series && (
              <button type="button" className={LINK} onClick={() => void apply('DELETE', { scope: 'SERIES' }, 'Rappels rétablis pour cette série.')}>
                Réactiver pour la série
              </button>
            )}
          </div>
        )}
      </div>
      {state && (
        <>
          <SnoozeDialog
            open={snooze} onOpenChange={setSnooze} subject={title}
            suggestedDate={state.occurrence?.decision === 'SNOOZED' && state.occurrence.remindAt ? state.occurrence.remindAt : state.suggestedDate}
            onConfirm={(day) => apply('POST', { action: 'SNOOZE', remindAt: day }, `C’est noté : je vous le rappellerai le ${reminderDateLabel(day)}.`)}
          />
          <DismissDialog
            open={dismiss} onOpenChange={setDismiss} hasSeries={state.hasSeries} subject={title}
            onConfirm={(scope) => apply('POST', { action: 'DISMISS', scope }, 'C’est noté : je ne vous le rappellerai plus.')}
          />
        </>
      )}
    </div>
  );
}
