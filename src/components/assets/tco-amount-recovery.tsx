"use client"

/**
 * Lot 108B — justificatifs du coût de possession dont le montant est inconnu
 * (ticket TCO-646 §B). Trois états, calculés côté serveur à partir de l'état
 * PERSISTÉ de la récupération automatique (aucune relecture à l'affichage) :
 *   · « Lecture du montant en cours » : ton neutre, rien à faire (la relecture
 *     automatique, ou sa reprise après un incident technique, est prévue) ;
 *   · « Montant à confirmer » / « Montant introuvable » : après l'échec RÉEL
 *     de la récupération — document identifié, lien direct (tiroir document,
 *     où le montant se saisit) et action explicite.
 * Lot 111V (§D) : états RÉELS (persistance + file `ai_job_queue`) — « En
 * attente de prise en charge » (travail en file), « Lecture du montant en
 * cours » (travail RUNNING seulement), « Nouvelle tentative prévue » (date),
 * « Vérification automatique à venir » (aucun travail : rien n'est annoncé
 * comme lancé). Les échecs réels restent dans « Points à vérifier ».
 * Jamais de carte « À traiter » : ce bloc est le seul endroit où la demande
 * apparaît. Desktop et mobile (cibles de 44 px), charte Sérénité (jetons).
 */
import { Clock, FileQuestion } from 'lucide-react';
import { AMOUNT_RECOVERY_PENDING_STATES, AMOUNT_RECOVERY_VIEW_LABELS, type AmountRecoveryViewState, type TcoAmountRecoveryView } from '@/services/business-operations/tco/amount-recovery';
import { TcoJustificatif } from './tco-justificatif';

const ORDRE: readonly AmountRecoveryViewState[] = ['TECHNICAL_FAILURE', 'NOT_FOUND', 'TO_CONFIRM', 'READING', 'QUEUED', 'RETRY_SCHEDULED', 'WAITING'];

const jj = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);

export function TcoAmountRecoveryNotice({ recovery }: { recovery: TcoAmountRecoveryView | null | undefined }) {
  if (!recovery?.items.length) return null;
  return (
    <section className="space-y-2" data-tco-amount-recovery aria-label="Justificatifs sans montant">
      {ORDRE.map((etat) => {
        const items = recovery.items.filter((i) => i.state === etat);
        if (!items.length) return null;
        const libelle = AMOUNT_RECOVERY_VIEW_LABELS[etat];
        const enCours = AMOUNT_RECOVERY_PENDING_STATES.has(etat);
        const Icone = enCours ? Clock : FileQuestion;
        return (
          <div
            key={etat}
            className={`rounded-lg border px-4 py-3 space-y-1.5 ${enCours ? 'border-border bg-muted/30' : 'border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)]'}`}
            data-tco-amount-recovery-state={etat}
          >
            <p className={`text-sm font-medium flex items-center gap-1.5 ${enCours ? 'text-foreground' : 'text-[color:var(--attention-on-soft)]'}`}>
              <Icone className="w-4 h-4 shrink-0" aria-hidden /> {libelle.title}{items.length > 1 ? ` (${items.length})` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{libelle.text}</p>
            <ul className="space-y-1">
              {items.map((i) => (
                <li key={i.fileId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0" data-tco-amount-recovery-file={i.fileId}>
                  <TcoJustificatif fileId={i.fileId} title={i.title} />
                  {libelle.action && <span className="text-xs text-muted-foreground">— {libelle.action}</span>}
                  {i.nextAttemptAt && jj(i.nextAttemptAt) && (
                    <span className="text-xs text-muted-foreground" data-tco-amount-recovery-next>
                      {etat === 'RETRY_SCHEDULED' ? `— prochaine tentative à partir du ${jj(i.nextAttemptAt)}` : `— en file depuis le ${jj(i.nextAttemptAt)}`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
