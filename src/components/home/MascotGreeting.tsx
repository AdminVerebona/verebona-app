"use client"

/**
 * MascotPresenter — zone mascotte de l'accueil (CDC « Mascotte d'accueil & T6 » V1, §4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AFFICHER, SANS RIEN DÉCIDER
 *
 * Le serveur décide quoi dire et quels boutons proposer (moteur déterministe),
 * T6 comment le dire. Ce composant ne fait qu'afficher :
 *   · mascotte à gauche, une seule bulle à droite (UX-001, UX-005) ;
 *   · « Bonjour » avant 18:00, « Bonsoir » ensuite, à l'heure du terminal,
 *     avec le prénom (UX-002, UX-003) ; la date sous la salutation (UX-004) ;
 *   · un paragraphe par sujet, ses actions juste en dessous (UX-006) ;
 *   · les éléments secondaires ensuite — 5 actions au total au plus (UX-007).
 * La priorité n'est jamais affichée (UX-009).
 *
 * Chaque clic revalide sa cible (REF-004) ; une cible disparue ou une action
 * déjà traitée est signalée puis la prise de parole est recalculée (§20).
 * ══════════════════════════════════════════════════════════════════════════
 */
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { openDrawer } from '@/lib/drawers';
import { openToProcessTarget } from '@/lib/to-process-target';
import { formatGreetingDate, greetingWord, splitHighlight } from '@/lib/mascot-greeting';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import type { MascotAction, MascotPresentation } from '@/services/home/mascot/types';
import { useMascotPresentation } from './useMascotPresentation';

interface MascotGreetingProps {
  /** Prénom : c'est le nom affiché (UX-003). */
  firstName: string;
  onCreateAsset: () => void;
  onUploadDocument: () => void;
}

const BTN_PRIMARY = 'inline-flex items-center min-h-[36px] px-3.5 py-1.5 rounded-full border border-[color:var(--accent)] '
  + 'text-[12.5px] font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-1 disabled:opacity-50';
const BTN_SECONDARY = 'inline-flex items-center min-h-[36px] px-3.5 py-1.5 rounded-full border border-[color:var(--border-subtle)] '
  + 'text-[12.5px] text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] hover:border-[color:var(--text-muted)] transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-1 disabled:opacity-50';

export function MascotGreeting({ firstName, onCreateAsset, onUploadDocument }: MascotGreetingProps) {
  const router = useRouter();
  const { garder } = useWriteGuard();
  const { presentation, failed, refresh, trackClick } = useMascotPresentation();
  const [busy, setBusy] = useState<string | null>(null);
  const now = new Date();

  /** Revalide la cible côté serveur, puis ouvre le parcours existant. */
  const run = async (action: MascotAction, occurrenceKey: string, sourceCode: string, placement: 'subject' | 'secondary') => {
    trackClick(occurrenceKey, sourceCode, placement, action.actionId);
    const t = action.target;

    if (t.kind === 'ask') {
      window.dispatchEvent(new CustomEvent('verebona:open', { detail: { question: t.question, context: t.context } }));
      return;
    }
    if (t.kind === 'create_asset') { onCreateAsset(); return; }
    if (t.kind === 'upload_document') { onUploadDocument(); return; }

    setBusy(action.actionId);
    try {
      const res = await fetch('/api/home/mascot/check', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: t }),
      });
      const { status } = res.ok ? await res.json() as { status: 'ok' | 'gone' | 'resolved' } : { status: 'ok' as const };
      if (status === 'gone') {
        toast.info('Cet élément n’est plus disponible.');
        void refresh();
        return;
      }
      if (status === 'resolved') {
        toast.info('Cette action est déjà traitée.');
        void refresh();
        return;
      }

      switch (t.kind) {
        case 'drawer':
          openDrawer(t.drawer === 'document'
            ? { kind: 'document', id: t.id, showAnalysisResults: t.showAnalysisResults }
            : { kind: t.drawer, id: t.id, initialMode: t.mode });
          break;
        case 'to_process':
          openToProcessTarget(t, router, () => router.push('/accueil/a-traiter'));
          break;
        case 'route':
          router.push(t.href);
          break;
        case 'done':
          await markDone(t.occurrenceKey, t.cycleKey);
          break;
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * « C'est fait » (DONE-001 à DONE-003) : l'occurrence est close pour le
   * compte, un toast propose « Annuler » quelques secondes. Si l'écriture
   * échoue, la recommandation reste affichée (§20).
   */
  const markDone = async (occurrenceKey: string, cycleKey: string) => {
    let autorise = false;
    garder(() => { autorise = true; });
    if (!autorise) return;
    try {
      await apiClient.post('/api/home/mascot/done', { occurrenceKey, cycleKey });
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'L’action n’a pas pu être enregistrée. Réessayez.');
      return;
    }
    void refresh();
    toast.success('C’est noté.', {
      duration: 8_000,
      action: {
        label: 'Annuler',
        onClick: async () => {
          try {
            await apiClient.delete('/api/home/mascot/done', { body: JSON.stringify({ occurrenceKey, cycleKey }) });
            void refresh();
          } catch (e) {
            toast.error((e as { message?: string }).message ?? 'Il n’est plus possible d’annuler.');
          }
        },
      },
    });
  };

  return (
    <div className="flex items-start sm:items-center gap-3 sm:gap-6 min-w-0">
      {/* Mobile : la mascotte rétrécit avant le texte (UX-010). */}
      <Image
        src="/mascot/dialogue-bubble.webp"
        alt=""
        aria-hidden="true"
        width={124}
        height={124}
        priority
        className="w-12 h-12 min-[380px]:w-16 min-[380px]:h-16 sm:w-[124px] sm:h-[124px] flex-shrink-0 select-none animate-[vb-float_6s_ease-in-out_infinite] [filter:drop-shadow(0_20px_32px_rgba(4,10,26,.6))]"
      />
      <section
        aria-label="Message de Verebona"
        className="flex-1 min-w-0 rounded-[22px] rounded-bl-md bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-md px-4 sm:px-5 py-4"
      >
        <h1 className="text-[19px] sm:text-[21px] font-semibold tracking-tight text-[color:var(--text-primary)] break-words">
          {greetingWord(now)}, <span className="text-[color:var(--accent)]">{firstName}</span>
        </h1>
        <p className="text-xs text-[color:var(--text-muted)] mb-2 first-letter:uppercase">{formatGreetingDate(now)}</p>

        {/* Hauteur réservée pour 1 à 2 paragraphes : pas de saut de mise en page (NFR-007). */}
        <div className="min-h-[88px]" aria-live="polite" aria-busy={!presentation && !failed}>
          {!presentation && !failed && <MascotSkeleton />}
          {!presentation && failed && (
            <p className="text-[13.5px] leading-relaxed text-[color:var(--text-secondary)]">
              Certaines informations n’ont pas pu être actualisées.
            </p>
          )}
          {presentation && (
            <MascotBody presentation={presentation} busy={busy} onAction={run} />
          )}
        </div>
      </section>
    </div>
  );
}

function MascotSkeleton() {
  return (
    <div className="space-y-2 animate-pulse" role="status" aria-label="Chargement du message">
      <div className="h-3.5 rounded bg-[color:var(--border-subtle)] w-11/12" />
      <div className="h-3.5 rounded bg-[color:var(--border-subtle)] w-9/12" />
      <div className="h-8 rounded-full bg-[color:var(--border-subtle)] w-32 mt-3" />
    </div>
  );
}

function MascotBody({ presentation, busy, onAction }: {
  presentation: MascotPresentation;
  busy: string | null;
  onAction: (a: MascotAction, occurrenceKey: string, sourceCode: string, placement: 'subject' | 'secondary') => void;
}) {
  return (
    <div className="space-y-3">
      {presentation.paragraphs.map((p) => (
        <div key={p.subjectId} className="space-y-2">
          <p className="text-[13.5px] leading-relaxed text-[color:var(--text-secondary)] max-w-2xl break-words">
            {splitHighlight(p.text, p.highlight).map((part, i) => (part.strong
              ? <strong key={i} className="font-semibold text-[color:var(--text-primary)]">{part.text}</strong>
              : <span key={i}>{part.text}</span>))}
          </p>
          {p.actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {p.actions.map((a) => (
                <button
                  key={a.actionId}
                  type="button"
                  disabled={busy === a.actionId}
                  onClick={() => onAction(a, p.occurrenceKey, p.sourceCode, 'subject')}
                  className={BTN_PRIMARY}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      {presentation.degradedNotice && (
        <p className="text-xs text-[color:var(--text-muted)]" role="note">{presentation.degradedNotice}</p>
      )}

      {presentation.secondaries.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1" aria-label="Autres suggestions">
          {presentation.secondaries.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy === s.action.actionId}
              onClick={() => onAction(s.action, s.occurrenceKey, s.sourceCode, 'secondary')}
              className={BTN_SECONDARY}
            >
              {s.action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* Ajouter une fois dans globals.css :
@keyframes vb-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-9px) } }
*/
