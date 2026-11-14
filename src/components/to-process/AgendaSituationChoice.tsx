'use client';

/**
 * Carte « À traiter » de QUALIFICATION d'un événement d'Agenda hérité sans
 * date — lot 114V (Trello #742 §6).
 *
 * La question est neutre (« Cet événement est-il à prévoir ou a-t-il déjà eu
 * lieu ? ») : DEUX choix de même poids, « A eu lieu » / « À prévoir », AUCUN
 * présélectionné, et une date FACULTATIVE. Le choix est écrit par le service
 * de l'Agenda (`PUT /api/agenda/[id]`, mêmes validations que le tiroir :
 * « A eu lieu » + date future → refus affiché ici, rien n'est écrit) ; la
 * situation est persistée sur l'élément, la carte est fermée par le producteur
 * (motif tracé) et n'est jamais régénérée. « Ouvrir » mène à la fiche.
 * Zones tactiles de 36 px au moins ; les boutons passent à la ligne à 320 px.
 */
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { MICROCOPY } from '@/lib/referential/v2/microcopy';
import { AGENDA_SITUATIONS, SITUATION_LABELS, type AgendaSituation } from '@/lib/agenda/situation';
import { PROPOSAL_BUTTON_CLASS } from './proposal-button';
import { notifyToProcessChanged } from './useToProcessResolution';

/** Libellés propres à la carte (textes à valider par le PO). */
export const SITUATION_CARD_LABELS = {
  optionalDate: 'Date (facultative)',
  saved: (s: AgendaSituation) => `Événement enregistré : ${SITUATION_LABELS[s]}.`,
  failed: 'L’enregistrement n’a pas abouti.',
} as const;

/** Corps de la demande (pur, testé) : la situation choisie, et la date seulement si elle est saisie. */
export function situationChoicePayload(situation: AgendaSituation, date: string): { situation: AgendaSituation; startDate?: string } {
  const d = date.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? { situation, startDate: d } : { situation };
}

export function AgendaSituationChoice({ agendaItemId, question, busy, onOpen }: {
  agendaItemId: number;
  /** Question de la carte (libellé accessible du groupe de choix). */
  question: string;
  busy?: boolean;
  onOpen: () => void;
}) {
  const [date, setDate] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();
  const off = busy || pending;

  const choisir = async (situation: AgendaSituation) => {
    setPending(true);
    setError(null);
    try {
      await apiClient.put(`/api/agenda/${agendaItemId}`, situationChoicePayload(situation, date));
      toast.success(SITUATION_CARD_LABELS.saved(situation));
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('agenda-mutated'));
      notifyToProcessChanged();
    } catch (e) {
      const err = e as { serverMessage?: string; message?: string } | null;
      setError((err?.serverMessage || err?.message || SITUATION_CARD_LABELS.failed).replace(/^Validation : /, ''));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-situation-choice className="flex min-w-0 max-w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={dateId} className="text-xs text-muted-foreground">{SITUATION_CARD_LABELS.optionalDate}</label>
        <Input
          id={dateId}
          type="date"
          value={date}
          onChange={(e) => { setDate(e.target.value); setError(null); }}
          disabled={off}
          className="h-9 w-auto min-w-[10rem]"
        />
      </div>
      {/* Deux choix de même poids (contour neutre) : aucun n'est présélectionné ni mis en avant. */}
      <div role="group" aria-label={question} className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {AGENDA_SITUATIONS.map((s) => (
          <Button key={s} type="button" size="sm" variant="outline" disabled={off} data-situation={s} onClick={() => { void choisir(s); }} className={PROPOSAL_BUTTON_CLASS}>
            <span className="min-w-0 [overflow-wrap:anywhere]">{SITUATION_LABELS[s]}</span>
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" disabled={off} onClick={onOpen} className="h-9">
          {MICROCOPY.open}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-[color:var(--danger)]">{error}</p>}
    </div>
  );
}
