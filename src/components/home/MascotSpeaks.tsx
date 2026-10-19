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
 *   1. synthèse — lot 71F : SUPPRIMÉE (« Deux sujets nécessitent votre
 *      attention aujourd’hui. ») ; les cartes présentent directement les
 *      « À traiter » DO_FIRST (au plus deux, lot 34) et l'invitation Duo ;
 *      sans phrase d'en-tête, la bulle commence par les cartes — aucun
 *      paragraphe vide ;
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
 *
 * ── LOT 68 : UN BLOC PAR SUJET ─────────────────────────────────────────────
 *
 *   Plus d'introduction de comptage ni de carte imbriquée qui répète le
 *   message : chaque sujet retenu est UN bloc — sa formulation (objet, bien
 *   et date une seule fois), « Voir » (détail) et, pour une échéance décidée,
 *   le menu « Rappels » (« Me le rappeler plus tard », « Ne plus me
 *   rappeler »). Un rappel informatif garde la tonalité d'une information,
 *   jamais celle d'une action. Desktop et mobile : même composant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  bubbleLead, displayedSecondaries, duoInviteHomeItem, homeItems, homePose, homePoseLabel, homeSuggestions, splitHighlights, subjectBlocks,
  type HomeItem, type SubjectBlock,
} from '@/services/home/mascot/bubble';
import { MascotPose } from '@/components/verebona/space/MascotPose';
import { useVerebonaSpace } from '@/components/verebona/space/VerebonaSpaceProvider';
import { useMascotPresentation } from './useMascotPresentation';
import { TodoChoicesDialog } from './TodoChoicesDialog';
import { T6ReminderActions } from './T6ReminderControls';
import { BLOCK_ACTION_PRIMARY } from './bubble-actions';

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
/** Bulle mascotte (charte 2026 §1.2) : #ECF1EF bord #BBD0CC / sombre #243C40 bord #3E5F63. */
const BUBBLE_BG = 'var(--bubble)';
const BUBBLE_EDGE = 'var(--bubble-edge)';

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

  // Lot 68 : en-tête seul (évaluation, panne, rien à signaler…) ; chaque
  // sujet est dit UNE fois, dans son bloc. Lot 71F : jamais d'introduction
  // de comptage — en-tête vide le plus souvent, et alors non rendu.
  const speech = bubbleLead({ presentation, empty, failed });
  const blocks = empty ? [] : subjectBlocks(presentation);
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
    if (it.kind === 'subject') { const a = it.tile.paragraph.actions[0]; if (a) void run(a, it.tile.paragraph, 'subject'); return; }
    void run(it.secondary.action, it.secondary, 'secondary');
  };

  /** Lot 68 : sujet reporté / refusé depuis son menu « Rappels » — retiré aussitôt. */
  const onReminderDone = (occurrenceKey: string) => (kind: 'snoozed' | 'dismissed' | 'cleared') => {
    if (kind === 'cleared') { setHiddenSubjects((h) => { const n = new Set(h); n.delete(occurrenceKey); return n; }); }
    else setHiddenSubjects((h) => new Set(h).add(occurrenceKey));
    void refresh();
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
  // Lot 68 / 71F : « Inviter quelqu'un » et « À traiter » d'abord, présentés
  // directement (aucune phrase qui les compte), puis les blocs de sujet, puis
  // l'étape d'accueil / recommandations.
  const itemsTete = items.filter((it) => it.kind === 'duo-invite' || it.kind === 'todo');
  const itemsSuite = items.filter((it) => it.kind !== 'duo-invite' && it.kind !== 'todo');
  /** Élément de niveau 2 (« À traiter », Duo, accueil, recommandation) : même composant. */
  const renderItem = (it: HomeItem) => (
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
      {/* Mascotte immobile (§12bis), sans ombre portée (charte 2026 : une
          seule ombre, réservée aux cartes flottantes) ; recoloration cyan
          appliquée par MascotPose. 112 px desktop, 72 px mobile. */}
      <div className="flex-shrink-0 self-start md:row-span-3">
        <MascotPose pose={pose} size={112} alt={homePoseLabel(pose)} priority className="hidden md:block" />
        <MascotPose pose={pose} size={72} alt={homePoseLabel(pose)} priority className="md:hidden" />
      </div>

      <div className="flex min-w-0 flex-col gap-1 md:gap-3.5 md:pt-1.5">
        <span className="text-[12px] text-[color:var(--text-muted)] md:text-[13px]">{greetingDateLong(now)}</span>
        <h1 className="m-0 text-[26px] font-extrabold leading-[1.1] tracking-[-.03em] text-[color:var(--text-primary)] md:text-[32px]">
          {greetingWord(now)}, {greetingName}
        </h1>
      </div>

      {/* Bulle : coin resserré et pointe vers la mascotte (gauche desktop, haut mobile) */}
      <div
        data-mascot-bubble
        className="relative col-span-2 mt-1 flex min-w-0 flex-col gap-2.5 rounded-[20px] rounded-tl-[6px] border px-4 py-3 md:col-span-1 md:col-start-2 md:mt-0 md:gap-3 md:px-[22px] md:py-4"
        style={{ background: BUBBLE_BG, borderColor: BUBBLE_EDGE }}
      >
        <span
          aria-hidden
          className="absolute left-7 top-[-7px] h-3 w-3 rotate-45 border-l border-t md:left-[-7px] md:top-[26px] md:border-b md:border-t-0"
          style={{ background: BUBBLE_BG, borderColor: BUBBLE_EDGE }}
        />
        {(loading || speech.text) && (
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
        )}

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
        ) : (
          <>
            {itemsTete.length > 0 && (
              <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-2.5" aria-label="Sujets à traiter">
                {itemsTete.map(renderItem)}
              </div>
            )}
            {/* Lot 68 : un bloc par sujet retenu — texte, « Voir », « Rappels ». */}
            {!loading && blocks.length > 0 && (
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Sujets du jour" aria-live="polite">
                {blocks.map((b, i) => (
                  <SubjectBlockView
                    key={b.key}
                    block={b}
                    first={i === 0}
                    onAction={(a) => { void run(a, b.paragraph, 'subject'); }}
                    onReminderDone={onReminderDone(b.key)}
                  />
                ))}
              </ul>
            )}
            {itemsSuite.length > 0 && (
              <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-2.5" aria-label="Pour continuer">
                {itemsSuite.map(renderItem)}
              </div>
            )}
          </>
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
              className="h-8 flex-shrink-0 whitespace-nowrap rounded-full border border-[color:var(--border)] px-3.5 text-[13px] text-[color:var(--text-primary)] transition-colors duration-[180ms] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]"
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

/** Intitulé du sujet dans les fenêtres de rappel : on sait toujours QUELLE échéance est visée. */
function reminderSubject(p: MascotParagraph): string {
  const t = p.tile;
  if (!t) return p.text;
  const date = t.status.split(' · ').pop() ?? '';
  return [t.label, t.assetName, /\d{4}/.test(date) ? date : null].filter(Boolean).join(' · ');
}

/**
 * Lot 68 — bloc d'un sujet : pictogramme de nature (information bleue ou
 * action), nature d'une action le cas échéant (jamais « Action à prévoir »
 * pour un rappel informatif), la formulation UNE fois, puis « Voir » (accès
 * au détail), les autres actions réelles (« C’est fait ») et « Rappels ».
 * Zones tactiles : 44 px sur mobile, 36 px sur ordinateur ; aucun texte tronqué.
 */
function SubjectBlockView({ block, first, onAction, onReminderDone }: {
  block: SubjectBlock; first: boolean; onAction: (a: MascotAction) => void;
  onReminderDone: (kind: 'snoozed' | 'dismissed' | 'cleared') => void;
}) {
  const Icon = TILE_ICONS[block.icon] ?? CircleAlert;
  const t = TILE_TONES[block.tone] ?? TILE_TONES.blue;
  const textId = useId();
  return (
    <li
      data-subject-block={block.key}
      data-subject-nature={block.informative ? 'information' : 'action'}
      className={`flex min-w-0 gap-3 ${first ? '' : 'mt-2.5 border-t border-[color:var(--bubble-edge)] pt-2.5'}`}
    >
      <span aria-hidden className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]" style={{ background: t.bg, color: t.fg }}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {block.badge && (
          <span data-subject-badge className="self-start rounded-full px-2 py-0.5 text-[11.5px] font-semibold leading-[1.4]" style={{ background: t.bg, color: t.fg }}>
            {block.badge}
          </span>
        )}
        <p id={textId} className="m-0 break-words text-[15px] leading-[1.55] text-[color:var(--text-primary)] [text-wrap:pretty] md:text-[16px] md:leading-[1.6]">
          {splitHighlights(block.text, block.highlights).map((part, i) => (part.strong
            ? <strong key={i} className="font-semibold">{part.text}</strong>
            : <span key={i}>{part.text}</span>))}
        </p>
        {(block.actions.length > 0 || block.reminder) && (
          <div className="-ml-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {block.actions.map((a) => (
              <button key={a.action.actionId} type="button" className={BLOCK_ACTION_PRIMARY} onClick={() => onAction(a.action)} data-block-action={a.action.actionId}>
                {a.label}
                {a.primary && <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />}
              </button>
            ))}
            {block.reminder && (
              <T6ReminderActions reminder={block.reminder} subject={reminderSubject(block.paragraph)} onDone={onReminderDone} describedBy={textId} />
            )}
          </div>
        )}
      </div>
    </li>
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
      className="group flex min-h-[60px] items-center gap-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2.5 text-left text-[color:var(--text-primary)] transition-colors duration-[180ms] hover:border-[color:var(--accent)] md:gap-3.5 md:rounded-[18px] md:px-4 md:py-3.5"
    >
      <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl md:h-[42px] md:w-[42px] md:rounded-[13px]" style={{ background: t.bg, color: t.fg }}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:gap-[3px]">
        <span className="break-words text-[14px] font-semibold md:text-[14.5px]">{title}</span>
        {/* Lot 55A : bien · date complète, sur deux lignes si besoin — jamais tronqués (mobile comme desktop). */}
        {sub && <span data-item-sub className="break-words text-[12px] text-[color:var(--muted-foreground)] md:text-[12.5px]">{sub}</span>}
      </span>
      {cta && <span className="flex-shrink-0 text-[12.5px] font-semibold text-[color:var(--accent)] md:text-[13px]">{cta}</span>}
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]" strokeWidth={2.2} aria-hidden />
    </button>
  );
}
