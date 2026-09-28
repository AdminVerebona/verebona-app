"use client"
/**
 * La mascotte parle — Direction D v2 §3.2 (desktop), §4.2 (mobile), §12ter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MOTEUR DE LA MASCOTTE RESTE LA SOURCE
 *
 * Sujets choisis par le moteur déterministe, formulés par T6 (ou leur texte
 * de secours), actions résolues par le serveur, revalidées au clic (REF-004),
 * télémétrie « affiché / cliqué / disparu » (§17) : rien ne change. Seule la
 * mise en scène change :
 *   · une phrase naturelle à partir des sujets (au lieu d'un paragraphe par
 *     sujet) ;
 *   · au plus 2 tuiles d'action ; un clic ouvre l'espace de réponse Verebona
 *     sur le sujet, où ses actions réelles sont proposées ;
 *   · « Ou demandez-moi : » et 3 pastilles, envoyées directement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { toast } from 'sonner';
import { ArrowRight, CalendarDays, CircleAlert, Clock, Download, FileText, Plus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { openDrawer } from '@/lib/drawers';
import { openToProcessTarget } from '@/lib/to-process-target';
import { greetingDateLong, greetingDateShort, greetingWord } from '@/lib/mascot-greeting';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import type { MascotAction, MascotParagraph, MascotTile } from '@/services/home/mascot/types';
import {
  actionTiles, composeSpeech, displayedSecondaries, homePose, homePoseLabel, homeSuggestions, secondaryActions, splitHighlights, type ActionTile,
} from '@/services/home/mascot/bubble';
import type { AnswerKind } from '@/lib/verebona/space';
import { MascotPose } from '@/components/verebona/space/MascotPose';
import { useVerebonaSpace } from '@/components/verebona/space/VerebonaSpaceProvider';
import { useMascotPresentation } from './useMascotPresentation';

interface MascotSpeaksProps {
  firstName: string;
  /** Compte vide : aucun bien, aucun document (§12ter). */
  empty: boolean;
  onCreateAsset: () => void;
  onUploadDocument: (assetId?: number | null) => void;
  /** Suggestions du catalogue pour l'accueil, en complément du moteur. */
  pageSuggestions: string[];
}

const TILE_ICONS: Record<MascotTile['icon'], typeof CircleAlert> = {
  'circle-alert': CircleAlert, clock: Clock, 'calendar-days': CalendarDays, 'file-text': FileText, plus: Plus, download: Download,
};

const TILE_TONES: Record<MascotTile['tone'], { bg: string; fg: string }> = {
  amber: { bg: 'var(--wash-amber)', fg: 'var(--on-amber)' },
  red: { bg: 'var(--wash-red)', fg: 'var(--on-red)' },
  blue: { bg: 'var(--wash-blue)', fg: 'var(--on-blue)' },
  green: { bg: 'var(--wash-green)', fg: 'var(--on-green)' },
};

/** Nature de la réponse locale, pour la pose de la mascotte du champ. */
function kindOf(p: MascotParagraph): AnswerKind {
  if (p.sourceCode.startsWith('DATE')) return 'event';
  if (p.sourceCode.startsWith('PROC')) return 'doc';
  return 'action';
}

export function MascotSpeaks({ firstName, empty, onCreateAsset, onUploadDocument, pageSuggestions }: MascotSpeaksProps) {
  const router = useRouter();
  const space = useVerebonaSpace();
  const { garder } = useWriteGuard();
  // Télémétrie « affiché » : seulement les secondaires que la bulle montre.
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  const { presentation, failed, refresh, trackClick } = useMascotPresentation((p) => displayedSecondaries(p, emptyRef.current));
  const now = new Date();

  const speech = composeSpeech({ presentation, empty, failed });
  const pose = homePose(presentation, empty, failed);
  const loading = !empty && !presentation && !failed;

  // ── Actions réelles du moteur (revalidées au clic) ────────────────────────
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

  const run = async (action: MascotAction, p: Pick<MascotParagraph, 'occurrenceKey' | 'sourceCode'>, placement: 'subject' | 'secondary') => {
    trackClick(p.occurrenceKey, p.sourceCode, placement, action.actionId);
    const t = action.target;
    if (t.kind === 'ask') {
      void space?.ask(t.question, { intent: t.context.intent, ...(t.context.assetId ? { assetId: String(t.context.assetId) } : {}) });
      return;
    }
    space?.close();
    if (t.kind === 'create_asset') { onCreateAsset(); return; }
    if (t.kind === 'upload_document') { onUploadDocument(t.assetId ?? null); return; }
    try {
      const res = await fetch('/api/home/mascot/check', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: t }),
      });
      const { status } = res.ok ? await res.json() as { status: 'ok' | 'gone' | 'resolved' } : { status: 'ok' as const };
      if (status === 'gone') { toast.info('Cet élément n’est plus disponible.'); void refresh(); return; }
      if (status === 'resolved') { toast.info('Cette action est déjà traitée.'); void refresh(); return; }
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
    } catch {
      toast.error('Cette action n’a pas pu être ouverte. Réessayez.');
    }
  };

  /**
   * Clic sur une tuile (§3.2) : l'espace de réponse s'ouvre et reçoit la
   * demande correspondante — le sujet, dit par Verebona, et ses actions.
   * Une question (cible `ask`) part directement au moteur de l'assistant.
   */
  const openTile = (tile: ActionTile) => {
    const p = tile.paragraph;
    const first = p.actions[0];
    if (first?.target.kind === 'ask') { void run(first, p, 'subject'); return; }
    if (!space) { if (first) void run(first, p, 'subject'); return; }
    const question = tile.sub ? `${tile.label} · ${tile.sub.split(' · ')[0]}` : tile.label;
    space.askLocal({
      question,
      content: p.text,
      kind: kindOf(p),
      summary: tile.label,
      actions: p.actions.map((a, i) => ({ label: a.label, primary: i === 0, run: () => { void run(a, p, 'subject'); } })),
    });
  };

  /** Compte vide (§12ter) : les parcours d'ajout, dans l'espace de réponse. */
  const emptyTiles: Array<{ key: string; label: string; sub: string; tone: MascotTile['tone']; icon: MascotTile['icon']; go: () => void }> = [
    {
      key: 'add-asset', label: 'Ajouter un premier bien', sub: 'Maison, véhicule, objet…', tone: 'blue', icon: 'plus',
      go: () => space?.askLocal({
        question: 'Ajouter un bien',
        content: 'Je crée la fiche de votre bien : choisissez son type, puis donnez-lui un nom. Je vous indiquerai ensuite les documents utiles à rassembler.',
        kind: 'action', summary: 'Ajouter un bien',
        actions: [{ label: 'Créer la fiche du bien', primary: true, run: () => { space.close(); onCreateAsset(); } }],
      }),
    },
    {
      key: 'add-doc', label: 'Déposer un document', sub: 'Je le lis et le range pour vous', tone: 'green', icon: 'download',
      go: () => space?.askLocal({
        question: 'Déposer un document',
        content: 'Déposez une facture, un contrat, une garantie ou une notice : je la lis, j’en extrais les informations utiles et je la rattache au bon bien.',
        kind: 'help', summary: 'Déposer un document',
        actions: [{ label: 'Choisir un fichier', primary: true, run: () => { space.close(); onUploadDocument(null); } }],
      }),
    },
  ];

  const tiles = empty
    ? emptyTiles
    : actionTiles(presentation).map((t) => ({ key: t.key, label: t.label, sub: t.sub, tone: t.tone, icon: t.icon, go: () => openTile(t) }));
  const suggestions = homeSuggestions(presentation, empty, pageSuggestions);
  const autresActions = secondaryActions(presentation, empty);

  return (
    <section aria-label="Message de Verebona" className="flex flex-col md:flex-row md:items-end md:gap-1.5">
      {/* Mascotte : halo bleu, ombre au sol, immobile (§12bis) */}
      <div className="relative ml-1 flex h-[88px] w-[96px] flex-shrink-0 items-end justify-center md:ml-0 md:h-[156px] md:w-[156px]">
        <span className="absolute -inset-1.5 rounded-full md:-inset-2.5" style={{ background: 'radial-gradient(closest-side, rgba(59,130,246,.32), rgba(59,130,246,0))' }} aria-hidden />
        <span className="absolute bottom-0.5 left-[38px] right-[38px] hidden h-3 rounded-full bg-black/50 blur-[6px] md:block" aria-hidden />
        <MascotPose pose={pose} size={136} alt={homePoseLabel(pose)} priority className="relative hidden md:block" style={{ filter: 'drop-shadow(0 24px 34px rgba(4,10,26,.6))' }} />
        <MascotPose pose={pose} size={86} alt={homePoseLabel(pose)} priority className="relative md:hidden" style={{ filter: 'drop-shadow(0 14px 20px rgba(4,10,26,.6))' }} />
      </div>

      {/* Bulle : coin resserré vers la mascotte (inférieur gauche desktop, supérieur gauche mobile) */}
      <div
        className="mt-1.5 flex min-w-0 flex-1 flex-col gap-3.5 rounded-[8px_26px_26px_26px] border px-[18px] pb-4 pt-[18px] shadow-relief-lg md:mt-0 md:gap-[18px] md:rounded-[28px_28px_28px_8px] md:px-[30px] md:pb-6 md:pt-[26px]"
        style={{
          background: 'linear-gradient(135deg, var(--bg-card), color-mix(in srgb, var(--accent) 7%, var(--bg-card)))',
          borderColor: 'rgba(59,130,246,.28)',
        }}
      >
        <div className="flex flex-col gap-2 md:gap-2.5">
          <div className="flex items-baseline justify-between gap-2.5 md:justify-start md:gap-3.5">
            <h1 className="m-0 font-display text-[28px] font-semibold leading-[1.05] tracking-[-.03em] text-[color:var(--text-primary)] md:text-[36px]">
              {greetingWord(now)}, {firstName}
            </h1>
            <span className="text-[12px] text-[color:var(--text-muted)] md:hidden">{greetingDateShort(now)}</span>
            <span className="hidden text-[13px] text-[color:var(--text-muted)] md:inline">{greetingDateLong(now)}</span>
          </div>
          <div aria-live="polite" aria-busy={loading}>
            {loading ? (
              <div className="space-y-2 py-1" role="status" aria-label="Chargement du message">
                <div className="h-3.5 w-11/12 animate-pulse rounded bg-[color:var(--border-subtle)]" />
                <div className="h-3.5 w-8/12 animate-pulse rounded bg-[color:var(--border-subtle)]" />
              </div>
            ) : (
              <p className="m-0 max-w-[760px] text-[15px] leading-normal text-[color:var(--text-primary)] [text-wrap:pretty] md:text-[17px]">
                {splitHighlights(speech.text, speech.highlights).map((part, i) => (part.strong
                  ? <strong key={i} className="font-semibold">{part.text}</strong>
                  : <span key={i}>{part.text}</span>))}
              </p>
            )}
          </div>
        </div>

        {tiles.length > 0 && (
          <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-2.5">
            {tiles.map((t) => {
              const Icon = TILE_ICONS[t.icon] ?? CircleAlert;
              const tone = TILE_TONES[t.tone] ?? TILE_TONES.blue;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={t.go}
                  className="group flex min-h-[60px] items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--row-muted)] px-3 py-2.5 text-left text-[color:var(--text-primary)] transition-all duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:gap-3.5 md:rounded-[18px] md:px-4 md:py-3.5"
                >
                  <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl md:h-[42px] md:w-[42px] md:rounded-[13px]" style={{ background: tone.bg, color: tone.fg }}>
                    <Icon className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:gap-[3px]">
                    <span className="text-[14px] font-semibold md:text-[14.5px]">{t.label}</span>
                    {t.sub && <span className="truncate text-[12px] text-[color:var(--muted-foreground)] md:whitespace-normal md:text-[12.5px]">{t.sub}</span>}
                  </span>
                  <ArrowRight className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]" strokeWidth={2.2} aria-hidden />
                </button>
              );
            })}
          </div>
        )}

        {/* Secondaires du moteur qui ne sont pas des questions (onboarding,
            recommandations) : leur action réelle, comme avant la refonte. */}
        {autresActions.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Autres suggestions">
            {autresActions.map((sec) => (
              <button
                key={sec.id}
                type="button"
                onClick={() => { void run(sec.action, sec, 'secondary'); }}
                className="inline-flex h-9 items-center rounded-full border border-[color:var(--accent)] px-3.5 text-[13px] font-medium text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:h-8"
              >
                {sec.action.label}
              </button>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="-mx-[18px] flex items-center gap-2 overflow-x-auto px-[18px] vb-no-scrollbar md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
            <span className="mr-0.5 hidden text-[12.5px] text-[color:var(--text-muted)] md:inline">Ou demandez-moi :</span>
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => {
                  // Question du moteur : même parcours (et même télémétrie) qu'avant.
                  if (s.secondary) { void run(s.secondary.action, s.secondary, 'secondary'); return; }
                  void space?.ask(s.label);
                }}
                className="h-9 flex-shrink-0 whitespace-nowrap rounded-full border border-[color:var(--border-subtle)] px-3.5 text-[13px] text-[color:var(--text-muted)] transition-colors duration-150 hover:border-[color:var(--border)] hover:text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:h-8"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
