'use client';

/**
 * Rappels T6 de l'accueil — lot 60 (« Me le rappeler plus tard », « Ne plus
 * me rappeler »). Même composant sur desktop et mobile ; composants et
 * jetons existants uniquement (Dialog, DatePicker, RadioGroup, Button).
 *
 *   · `T6ReminderActions` : lot 68 — un bouton « Rappels » dans le bloc du
 *     sujet, qui ouvre un menu (clavier : Entrée / Espace / flèches /
 *     Échap ; mobile : toucher) avec « Me le rappeler plus tard » et « Ne
 *     plus me rappeler ». Les commandes visent TOUJOURS l'échéance de ce
 *     bloc ; fenêtres de date, de portée (occurrence / série), confirmations
 *     et erreurs inchangées ;
 *   · `T6ReminderSettings` : l'état et les mêmes commandes dans le détail de
 *     l'échéance (agenda), pour modifier ou annuler un choix.
 *
 * Préférence PERSONNELLE : l'échéance, ses documents et l'agenda restent
 * intacts ; dans un compte Duo, l'autre membre garde ses propres rappels.
 *
 * Lot 71G (T6-08) : une fenêtre ne se ferme qu'APRÈS la confirmation du
 * serveur — en cas d'échec (HTTP, réseau, date refusée), elle reste ouverte
 * avec la date choisie et le message d'erreur ; aucun succès annoncé, aucun
 * sujet masqué avant confirmation. Bornes de date identiques à l'API (date
 * civile réelle, de demain à deux ans, en Europe/Paris).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BellOff, BellRing, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { BLOCK_ACTION_SECONDARY } from './bubble-actions';
import { apiClient } from '@/lib/api-client';
import type { MascotReminderRef } from '@/services/home/mascot/types';
import { T6_MAX_SNOOZE_DAYS, addDays, parisDayOf, snoozeDateError } from '@/services/home/mascot/t6-interpellation';

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

/**
 * Bornes du report (lot 71G, T6-08) : demain et dans deux ans, « aujourd'hui »
 * étant celui d'Europe/Paris — les mêmes que l'API (jamais l'heure locale de
 * l'appareil, qui peut être dans un autre fuseau).
 */
export function snoozeBounds(now: Date = new Date()): { min: string; max: string; today: string } {
  const today = parisDayOf(now);
  return { today, min: addDays(today, 1), max: addDays(today, T6_MAX_SNOOZE_DAYS) };
}

/** Libellé de l'état courant (pur) : le refus de série l'emporte, puis le refus, puis le report. */
export function reminderStatusLabel(s: Pick<T6ReminderStateView, 'occurrence' | 'series'> | null): string {
  if (!s) return '…';
  if (s.series?.decision === 'DISMISSED') return 'Désactivés pour toutes les échéances de cette série';
  if (s.occurrence?.decision === 'DISMISSED') return 'Désactivés pour cette échéance';
  if (s.occurrence?.decision === 'SNOOZED' && s.occurrence.remindAt) return `Reportés au ${reminderDateLabel(s.occurrence.remindAt)}`;
  // Lot 71G : depuis le lot 68, une information utile peut aussi être rappelée (sans démarche).
  return 'Actifs : Verebona vous sollicite quand une démarche est utile ou qu’un rappel vous sera utile';
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

/**
 * Lot 71G (T6-08) — confirmation d'une fenêtre (pure, testée) : exécute
 * l'enregistrement et rend `null` SEULEMENT si le serveur l'a confirmé ;
 * sinon le message à afficher dans la fenêtre (qui reste ouverte). Une
 * erreur levée n'est jamais absorbée en succès.
 */
export async function confirmReminder(run: () => Promise<unknown>, fallback: string): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return message(e, fallback);
  }
}

/** Résultat d'une confirmation : `null` = enregistré (la fenêtre se ferme), sinon le message d'erreur. */
type Confirm<T> = (v: T) => Promise<string | null>;

/** Fenêtre « Me le rappeler plus tard » : date proposée, modifiable. */
function SnoozeDialog({ open, onOpenChange, suggestedDate, subject, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; suggestedDate: string; subject: string;
  onConfirm: Confirm<string>;
}) {
  const [day, setDay] = useState(suggestedDate);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const bornes = snoozeBounds();
  useEffect(() => { if (open) { setDay(suggestedDate); setErreur(null); } }, [open, suggestedDate]);
  const valider = async () => {
    // Même contrôle que l'API, avant l'envoi (date réelle, bornes Europe/Paris).
    const invalide = snoozeDateError(day, bornes.today);
    if (invalide) { setErreur(invalide); return; }
    setBusy(true);
    setErreur(null);
    try {
      const e = await onConfirm(day);
      if (e) setErreur(e);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md" data-testid="t6-snooze-dialog">
        <DialogHeader>
          <DialogTitle>Me le rappeler plus tard</DialogTitle>
          <DialogDescription>{subject} — je vous le rappellerai à cette date, si c’est toujours utile.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="t6-snooze-date" className="text-xs text-[color:var(--text-muted)]">Date du rappel</Label>
          <DatePicker id="t6-snooze-date" value={day} min={bornes.min} max={bornes.max} onChange={(v) => { setDay(v); setErreur(null); }} />
          {erreur && <p role="alert" className="text-sm text-[color:var(--danger)]" data-testid="t6-snooze-error">{erreur}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button
            disabled={busy || !day}
            onClick={() => void valider()}
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
  onConfirm: Confirm<'OCCURRENCE' | 'SERIES'>;
}) {
  const [scope, setScope] = useState<'OCCURRENCE' | 'SERIES'>('OCCURRENCE');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => { if (open) { setScope('OCCURRENCE'); setErreur(null); } }, [open]);
  const valider = async () => {
    setBusy(true);
    setErreur(null);
    try {
      const e = await onConfirm(hasSeries ? scope : 'OCCURRENCE');
      if (e) setErreur(e);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
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
        {erreur && <p role="alert" className="text-sm text-[color:var(--danger)]" data-testid="t6-dismiss-error">{erreur}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button
            disabled={busy}
            onClick={() => void valider()}
          >
            Ne plus me rappeler
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LINK = 'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-[color:var(--text-muted)] transition-colors duration-150 hover:text-[color:var(--accent)]';

const MENU_ITEM = 'min-h-[44px] gap-2.5 px-3 text-[14px] md:min-h-[36px]';

/**
 * Commandes de rappel d'un sujet T6 de l'accueil, regroupées sous « Rappels »
 * (lot 68). `subject` : intitulé du sujet (affiché dans le nom accessible du
 * bouton et dans la fenêtre : on sait toujours QUELLE échéance est visée).
 */
export function T6ReminderActions({ reminder, subject, onDone, describedBy }: {
  reminder: MascotReminderRef; subject: string; onDone: (kind: Done) => void;
  /**
   * Lot 68 : identifiant du texte du sujet — le bouton « Rappels » y renvoie
   * (`aria-describedby`) au lieu de répéter intitulé, bien et date.
   */
  describedBy?: string;
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
    <div className="inline-flex" data-t6-reminder={reminder.agendaItemId}>
      {/* Menu non modal : la fenêtre ouverte depuis un choix reçoit le focus normalement. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={BLOCK_ACTION_SECONDARY} {...(describedBy ? { 'aria-describedby': describedBy } : { 'aria-label': `Rappels : ${subject}` })} data-t6-reminder-menu>
            <BellRing className="h-3.5 w-3.5" aria-hidden /> Rappels <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[min(18rem,calc(100vw-2rem))]">
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => setSnooze(true)} data-t6-reminder-choice="snooze">
            <BellRing aria-hidden /> Me le rappeler plus tard
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => setDismiss(true)} data-t6-reminder-choice="dismiss">
            <BellOff aria-hidden /> Ne plus me rappeler
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SnoozeDialog
        open={snooze} onOpenChange={setSnooze} suggestedDate={reminder.suggestedDate} subject={subject}
        onConfirm={async (day) => {
          const erreur = await confirmReminder(
            () => send('POST', { agendaItemId: reminder.agendaItemId, action: 'SNOOZE', remindAt: day }),
            'Votre choix n’a pas pu être enregistré. Réessayez.');
          // Échec : la fenêtre reste ouverte (date et message conservés), rien n'est masqué.
          if (erreur) return erreur;
          onDone('snoozed');
          toast.success(`C’est noté : je vous le rappellerai le ${reminderDateLabel(day)}.`, {
            duration: 8_000, action: { label: 'Annuler', onClick: () => { void annuler('OCCURRENCE')(); } },
          });
          return null;
        }}
      />
      <DismissDialog
        open={dismiss} onOpenChange={setDismiss} hasSeries={reminder.hasSeries} subject={subject}
        onConfirm={async (scope) => {
          const erreur = await confirmReminder(
            () => send('POST', { agendaItemId: reminder.agendaItemId, action: 'DISMISS', scope }),
            'Votre choix n’a pas pu être enregistré. Réessayez.');
          if (erreur) return erreur;
          onDone('dismissed');
          toast.success('C’est noté : je ne vous le rappellerai plus. L’échéance reste dans l’agenda.', {
            duration: 8_000, action: { label: 'Annuler', onClick: () => { void annuler(scope)(); } },
          });
          return null;
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

  /** Rend `null` une fois la persistance CONFIRMÉE, sinon le message d'erreur (lot 71G). */
  const apply = async (method: 'POST' | 'DELETE', body: Record<string, unknown>, ok: string): Promise<string | null> => {
    let etat: T6ReminderStateView | null = null;
    const erreur = await confirmReminder(async () => { etat = await send(method, { agendaItemId, ...body }); }, 'Votre choix n’a pas pu être enregistré. Réessayez.');
    if (erreur) return erreur;
    setState(etat);
    window.dispatchEvent(new CustomEvent('verebona:data-mutated'));
    toast.success(ok);
    return null;
  };
  /** Commandes hors fenêtre (réactivation) : l'erreur est signalée, l'état reste celui du serveur. */
  const reactiver = async (scope: 'OCCURRENCE' | 'SERIES', ok: string) => {
    const erreur = await apply('DELETE', { scope }, ok);
    if (erreur) toast.error(erreur);
  };

  if (failed) return null;
  const actif = !state?.occurrence && !state?.series;
  return (
    <div className="flex items-start gap-3" data-testid="t6-reminder-settings">
      <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
        {actif ? <BellRing className="h-4 w-4 text-[color:var(--text-muted)]" /> : <BellOff className="h-4 w-4 text-[color:var(--text-muted)]" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="vb-app-label mb-1">Rappels sur l’accueil</p>
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
              <button type="button" className={LINK} onClick={() => void reactiver('OCCURRENCE', 'Rappels rétablis pour cette échéance.')}>
                Réactiver les rappels
              </button>
            )}
            {state.series && (
              <button type="button" className={LINK} onClick={() => void reactiver('SERIES', 'Rappels rétablis pour cette série.')}>
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
