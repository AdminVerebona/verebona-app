"use client"
/**
 * La mascotte parle — Direction D v2 §3.2 (desktop), §4.2 (mobile), §12ter.
 *
 * Lot 36 (maquette 2a/2b « Fil encadré ») : seule la MISE EN PAGE change —
 * mascotte à gauche, date + « Bonjour, … » + bulle (texte et actions) à
 * droite, pastilles de suggestions sous la bulle ; mobile : en-tête compact,
 * bulle pleine largeur. Moteur, actions, choix, DO_FIRST et télémétrie
 * inchangés.
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
 *   · « Ou demandez-moi : » et 3 pastilles, envoyées directement.
 *
 * ── LOT 32 (ticket MASC2) : DEUX NIVEAUX ───────────────────────────────────
 *
 *   1. synthèse : « Deux sujets nécessitent votre attention aujourd’hui. »
 *      Lot 34 (MASC3) : seuls les « À traiter » DO_FIRST sont affichés, au
 *      plus deux ; la phrase compte les éléments AFFICHÉS, jamais le total
 *      de la file (la pastille du menu le garde) ; plus de « N autres
 *      sujets dans « À traiter » » ;
 *   2. éléments d'action homogènes (`homeItems`) : « À traiter » d'abord,
 *      puis échéances et recommandations — un seul composant. Les pastilles
 *      « Compléter “…” » / « Choisir “…” » (3e niveau) sont supprimées.
 *
 *   Clic sur un « À traiter », selon le contrat (`actionType`, jamais un
 *   libellé) : OPEN_CHOICES → les choix de la file (`TodoChoicesDialog`,
 *   `ActionCard` + `useToProcessResolution`) ; OPEN_TODO_CARD → la carte
 *   de la file ciblée par son ID (`/accueil/a-traiter?todo=<id>`), ouverte et
 *   positionnée. Après résolution, l'élément disparaît aussitôt, puis la
 *   bulle, la file et la pastille se relisent (`refresh-a-traiter`).
 *   « Ou demandez-moi » reste séparé, sous les actions, secondaire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, CalendarDays, CircleAlert, Clock, Download, FileText, Plus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { openDrawer } from '@/lib/drawers';
import { openToProcessTarget } from '@/lib/to-process-target';
import { greetingDateLong, greetingWord } from '@/lib/mascot-greeting';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { preloadAddForm } from '@/components/mobile/add-forms';
import type { MascotAction, MascotParagraph, MascotPresentation, MascotTile, MascotTodoItem } from '@/services/home/mascot/types';
import {
  composeSpeech, displayedSecondaries, duoInviteHomeItem, homeItems, homePose, homePoseLabel, homeSuggestions, splitHighlights,
  type ActionTile, type HomeItem,
} from '@/services/home/mascot/bubble';
import type { AnswerKind } from '@/lib/verebona/space';
import { MascotPose } from '@/components/verebona/space/MascotPose';
import { useVerebonaSpace } from '@/components/verebona/space/VerebonaSpaceProvider';
import { useMascotPresentation } from './useMascotPresentation';
import { TodoChoicesDialog } from './TodoChoicesDialog';
import { T6ReminderActions } from './T6ReminderControls';

/** Page « À traiter » sur une carte précise (OPEN_TODO_CARD) — ciblage par ID. */
export function todoCardHref(todoId: string): string {
  return `/accueil/a-traiter?todo=${encodeURIComponent(todoId)}`;
}

/** Présentation sans les « À traiter » déjà résolus à l'écran (retrait immédiat). */
export function withoutTodos(p: MascotPresentation | null, hidden: ReadonlySet<string>): MascotPresentation | null {
  if (!p?.todo || hidden.size === 0) return p;
  const items = p.todo.items.filter((i) => !hidden.has(i.todoId));
  const retires = p.todo.items.length - items.length;
  return { ...p, todo: { total: Math.max(0, p.todo.total - retires), items } };
}

/**
 * Lot 60 : sujets T6 reportés ou refusés depuis leur carte — retirés aussitôt
 * (texte ET carte, mêmes décisions), jusqu'à la relecture qui fait foi.
 */
export function withoutSubjects(p: MascotPresentation | null, hidden: ReadonlySet<string>): MascotPresentation | null {
  if (!p || hidden.size === 0) return p;
  return { ...p, paragraphs: p.paragraphs.filter((x) => !hidden.has(x.occurrenceKey)) };
}

/** Tuile d'amorce d'un compte vide (§12ter). */
export interface EmptyStartTile {
  key: 'add-asset' | 'add-doc';
  label: string;
  sub: string;
  tone: MascotTile['tone'];
  icon: MascotTile['icon'];
  go: () => void;
}

/**
 * Lot 59, point 1 — tuiles « Ajouter un premier bien » / « Déposer un
 * document » d'un compte vide. Comme le menu « + Ajouter »
 * (`mobile-actions-sheet.tsx`) : formulaire préchargé, garde d'écriture
 * standard avec le quota concerné (fin d'essai, abonnement, quota : fenêtre
 * de refus habituelle), puis ouverture DIRECTE du formulaire d'ajout de bien
 * (`AssetFormDialog`) ou du tiroir d'ajout de document
 * (`UnifiedDocumentDialog`) monté par l'accueil. Aucun passage par T2.
 */
export function emptyStartTiles(deps: {
  garder: (action: () => void, quota?: 'assets' | 'documents') => void;
  closeSpace: () => void;
  onCreateAsset: () => void;
  onUploadDocument: (assetId?: number | null) => void;
}): EmptyStartTile[] {
  return [
    {
      key: 'add-asset', label: 'Ajouter un premier bien', sub: 'Maison, véhicule, objet…', tone: 'blue', icon: 'plus',
      go: () => { deps.closeSpace(); preloadAddForm('asset'); deps.garder(() => deps.onCreateAsset(), 'assets'); },
    },
    {
      key: 'add-doc', label: 'Déposer un document', sub: 'Je le lis et le range pour vous', tone: 'green', icon: 'download',
      go: () => { deps.closeSpace(); preloadAddForm('file'); deps.garder(() => deps.onUploadDocument(null), 'documents'); },
    },
  ];
}

interface MascotSpeaksProps {
  /** Nom affiché dans « Bonjour, … » : le nom d'utilisateur, à défaut le prénom. */
  greetingName: string;
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

/** Fond et bord de la bulle (maquette 2a/2b) : lavis d'accent sur le fond de page, dans les deux thèmes. */
const BUBBLE_BG = 'color-mix(in srgb, var(--accent) 9%, var(--bg-page))';
const BUBBLE_EDGE = 'color-mix(in srgb, var(--accent) 30%, transparent)';

/** Nature de la réponse locale, pour la pose de la mascotte du champ. */
function kindOf(p: MascotParagraph): AnswerKind {
  if (p.sourceCode.startsWith('DATE')) return 'event';
  if (p.sourceCode.startsWith('PROC')) return 'doc';
  return 'action';
}

export function MascotSpeaks({ greetingName, empty, onCreateAsset, onUploadDocument, pageSuggestions }: MascotSpeaksProps) {
  const router = useRouter();
  const space = useVerebonaSpace();
  const { garder } = useWriteGuard();
  // Télémétrie « affiché » : seulement les secondaires que la bulle montre.
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  const { presentation: brute, failed, refresh, trackClick } = useMascotPresentation((p) => displayedSecondaries(p, emptyRef.current));
  const now = new Date();

  // « À traiter » résolus depuis la bulle : retirés aussitôt, jusqu'à la
  // relecture (nouvelle empreinte) qui fait foi.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // Lot 60 : idem pour les sujets T6 reportés ou refusés depuis leur carte.
  const [hiddenSubjects, setHiddenSubjects] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setHidden(new Set()); setHiddenSubjects(new Set()); }, [brute?.contextHash]);
  const presentation = useMemo(() => withoutSubjects(withoutTodos(brute, hidden), hiddenSubjects), [brute, hidden, hiddenSubjects]);
  const [choices, setChoices] = useState<MascotTodoItem | null>(null);

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
   * Clic sur un « À traiter » (MASC2) — destination lue dans le contrat :
   * OPEN_CHOICES ouvre les choix de la file ; OPEN_TODO_CARD la carte de la
   * file, par son ID. Jamais le haut de la page « À traiter ».
   */
  const openTodo = (t: MascotTodoItem) => {
    trackClick(`ATP:${t.todoId}`, `ATP-${t.todoType}`, 'subject', `ATP:${t.todoId}:${t.actionType}`);
    space?.close();
    if (t.actionType === 'OPEN_CHOICES' && (t.availableChoices?.length ?? 0) >= 2) {
      setChoices(t);
      return;
    }
    router.push(todoCardHref(t.todoId));
  };

  const openItem = (it: HomeItem) => {
    // Lot 49A (ticket 13) : parcours d'invitation Duo existant (« Mon compte »).
    if (it.kind === 'duo-invite') {
      trackClick('DUO-INVITE', 'DUO-INVITE', 'subject', 'DUO-INVITE:open');
      space?.close();
      router.push(it.invite.href);
      return;
    }
    if (it.kind === 'todo') { openTodo(it.todo); return; }
    if (it.kind === 'subject') { openTile(it.tile); return; }
    void run(it.secondary.action, it.secondary, 'secondary');
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

  /**
   * Compte vide (§12ter) — lot 59, point 1 : les tuiles ouvrent DIRECTEMENT
   * les formulaires du menu « + Ajouter » (formulaire d'ajout de bien,
   * tiroir d'ajout de document), plus de détour par l'espace de réponse.
   */
  const emptyTiles = emptyStartTiles({
    garder,
    closeSpace: () => space?.close(),
    onCreateAsset,
    onUploadDocument,
  });

  const items = homeItems(presentation, empty);
  // Compte encore vide : « Inviter quelqu'un » avant les tuiles d'amorce (lot 49A).
  const emptyInvite = empty ? duoInviteHomeItem(presentation) : null;
  const suggestions = homeSuggestions(presentation, empty, pageSuggestions);

  // Lot 36 (maquette 2a/2b « Fil encadré ») : mascotte à gauche ; à droite
  // la date, « Bonjour, … », la bulle (texte et actions), puis les
  // suggestions en pastilles, hors de la bulle. Mobile : mascotte plus
  // petite avec la date et la salutation à côté, bulle et pastilles en
  // pleine largeur dessous. Une seule grille pour les deux.
  return (
    <section aria-label="Message de Verebona" className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-3 md:grid-cols-[112px_minmax(0,1fr)] md:items-start md:gap-x-7 md:gap-y-3.5">
      {/* Mascotte immobile (§12bis), ombre portée de la maquette */}
      <div className="flex-shrink-0 self-start md:row-span-3">
        <MascotPose pose={pose} size={112} alt={homePoseLabel(pose)} priority className="hidden md:block" style={{ filter: 'drop-shadow(0 20px 36px rgba(4,10,26,.45))' }} />
        <MascotPose pose={pose} size={72} alt={homePoseLabel(pose)} priority className="md:hidden" style={{ filter: 'drop-shadow(0 14px 24px rgba(4,10,26,.45))' }} />
      </div>

      <div className="flex min-w-0 flex-col gap-1 md:gap-3.5 md:pt-1.5">
        <span className="text-[12px] text-[color:var(--text-muted)] md:text-[13px]">{greetingDateLong(now)}</span>
        <h1 className="m-0 text-[22px] font-semibold leading-tight tracking-[-.02em] text-[color:var(--text-primary)] md:text-[26px]">
          {greetingWord(now)}, {greetingName}
        </h1>
      </div>

      {/* Bulle : coin resserré et pointe vers la mascotte (gauche desktop, haut mobile) */}
      <div
        data-mascot-bubble
        className="relative col-span-2 mt-1 flex min-w-0 flex-col gap-3 rounded-[20px] rounded-tl-[6px] border px-4 py-3.5 md:col-span-1 md:col-start-2 md:mt-0 md:px-[22px] md:py-[18px]"
        style={{ background: BUBBLE_BG, borderColor: BUBBLE_EDGE }}
      >
        <span
          aria-hidden
          className="absolute left-7 top-[-7px] h-3 w-3 rotate-45 border-l border-t md:left-[-7px] md:top-[26px] md:border-b md:border-t-0"
          style={{ background: BUBBLE_BG, borderColor: BUBBLE_EDGE }}
        />
        <div aria-live="polite" aria-busy={loading}>
          {loading ? (
            <div className="space-y-2 py-1" role="status" aria-label="Chargement du message">
              <div className="h-3.5 w-11/12 animate-pulse rounded bg-[color:var(--border-subtle)]" />
              <div className="h-3.5 w-8/12 animate-pulse rounded bg-[color:var(--border-subtle)]" />
            </div>
          ) : (
            <p className="m-0 text-[15px] leading-[1.55] text-[color:var(--text-primary)] [text-wrap:pretty] md:text-[16px] md:leading-[1.6]">
              {splitHighlights(speech.text, speech.highlights).map((part, i) => (part.strong
                ? <strong key={i} className="font-semibold">{part.text}</strong>
                : <span key={i}>{part.text}</span>))}
            </p>
          )}
        </div>

        {/* Niveau 2 : un seul composant pour toutes les actions (MASC2). */}
        {empty ? (
          <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-2.5">
            {emptyInvite && (
              <ItemButton title={emptyInvite.title} sub={emptyInvite.sub} cta={emptyInvite.cta} tone={emptyInvite.tone} icon={emptyInvite.icon} onClick={() => openItem(emptyInvite)} dataActionType="DUO_INVITE" />
            )}
            {emptyTiles.map((t) => (
              <ItemButton key={t.key} title={t.label} sub={t.sub} cta={null} tone={t.tone} icon={t.icon} onClick={t.go} />
            ))}
          </div>
        ) : items.length > 0 && (
          <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-2.5" aria-label="Sujets à traiter">
            {items.map((it) => {
              const bouton = (
                <ItemButton
                  key={it.key}
                  title={it.title}
                  sub={it.sub}
                  cta={it.cta}
                  tone={it.tone}
                  icon={it.icon}
                  onClick={() => openItem(it)}
                  dataTodoId={it.kind === 'todo' ? it.todo.todoId : undefined}
                  dataActionType={it.kind === 'todo' ? it.todo.actionType : it.kind === 'duo-invite' ? 'DUO_INVITE' : undefined}
                />
              );
              // Lot 60 : carte T6 d'une échéance décidée — commandes de rappel
              // sous la carte, visant cette seule échéance.
              const rappel = it.kind === 'subject' ? it.tile.paragraph.reminder : null;
              if (!rappel || it.kind !== 'subject') return bouton;
              const occurrenceKey = it.tile.paragraph.occurrenceKey;
              return (
                <div key={it.key} className="flex min-w-0 flex-col gap-0.5">
                  {bouton}
                  <T6ReminderActions
                    reminder={rappel}
                    subject={it.sub ? `${it.title} · ${it.sub}` : it.title}
                    onDone={(kind) => {
                      if (kind === 'cleared') { setHiddenSubjects((h) => { const n = new Set(h); n.delete(occurrenceKey); return n; }); }
                      else setHiddenSubjects((h) => new Set(h).add(occurrenceKey));
                      void refresh();
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* « Ou demandez-moi » : pastilles sous la bulle ; défilement horizontal sur mobile. */}
      {suggestions.length > 0 && (
        <div className="col-span-2 -mx-4 flex items-center gap-2 overflow-x-auto px-4 vb-no-scrollbar md:col-span-1 md:col-start-2 md:mx-0 md:mt-1 md:flex-wrap md:overflow-visible md:px-0" aria-label="Ou demandez-moi">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                // Question du moteur : même parcours (et même télémétrie) qu'avant.
                if (s.secondary) { void run(s.secondary.action, s.secondary, 'secondary'); return; }
                void space?.ask(s.label);
              }}
              className="h-8 flex-shrink-0 whitespace-nowrap rounded-full border border-[color:var(--border)] px-3.5 text-[13px] text-[color:var(--text-primary)] transition-colors duration-150 hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <TodoChoicesDialog
        item={choices}
        onClose={() => setChoices(null)}
        onRemoved={(id) => setHidden((h) => new Set(h).add(id))}
        onRestored={(id) => setHidden((h) => { const n = new Set(h); n.delete(id); return n; })}
      />
    </section>
  );
}

/**
 * Élément de niveau 2 — même composant pour un « À traiter », une échéance,
 * une recommandation ou une étape d'accueil (MASC2) : pictogramme coloré,
 * libellé, contexte, appel à l'action.
 */
function ItemButton({ title, sub, cta, tone, icon, onClick, dataTodoId, dataActionType }: {
  title: string; sub: string | null; cta: string | null; tone: MascotTile['tone']; icon: MascotTile['icon'];
  onClick: () => void; dataTodoId?: string; dataActionType?: string;
}) {
  const Icon = TILE_ICONS[icon] ?? CircleAlert;
  const t = TILE_TONES[tone] ?? TILE_TONES.blue;
  return (
    <button
      type="button"
      onClick={onClick}
      data-todo-id={dataTodoId}
      data-action-type={dataActionType}
      className="group flex min-h-[60px] items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--row-muted)] px-3 py-2.5 text-left text-[color:var(--text-primary)] transition-all duration-150 hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] md:gap-3.5 md:rounded-[18px] md:px-4 md:py-3.5"
    >
      <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl md:h-[42px] md:w-[42px] md:rounded-[13px]" style={{ background: t.bg, color: t.fg }}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:gap-[3px]">
        <span className="break-words text-[14px] font-semibold md:text-[14.5px]">{title}</span>
        {/* Lot 55A : bien · date complète, sur deux lignes si besoin — jamais tronqués (mobile comme desktop). */}
        {sub && <span data-item-sub className="break-words text-[12px] text-[color:var(--muted-foreground)] md:text-[12.5px]">{sub}</span>}
      </span>
      {cta && <span className="flex-shrink-0 text-[12.5px] font-medium text-[color:var(--accent)] md:text-[13px]">{cta}</span>}
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]" strokeWidth={2.2} aria-hidden />
    </button>
  );
}
