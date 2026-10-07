'use client';
/**
 * Contenu de l'espace de réponse — Direction D v2 §6.4, §6.5, §7, §8.
 *
 * Un seul langage visuel quel que soit le traitement : question grise
 * précédée de « › », réponse en retrait avec un liseré (neutre, vert, rouge),
 * faite des mêmes briques facultatives — phrase, objets, actions.
 */
import { useEffect, useState } from 'react';
import {
  ArrowRight, Building2, CalendarDays, CircleAlert, Clock, FileText, Info, Package, Trash2,
} from 'lucide-react';
import type { LiveResult } from '@/lib/verebona/live-search';
import type { VerebonaAction, VerebonaMessage } from '@/lib/verebona/useVerebona';
import { OFFLINE_PENDING_LABEL } from '@/lib/verebona/offline';
import { processingStatus, visibleResultGroups } from '@/lib/verebona/assistant-ui';
import {
  objectsFromCards, olderLabel, railTone, showAnswerText, splitTurns, timelineRows, turnSummary,
  type SpaceObject, type SpaceTurn,
} from '@/lib/verebona/space';
import { openDrawerFromLink } from '@/lib/drawers';
import { trackAssistantUsage } from '@/lib/verebona/usage-events';
import { VerebonaCommandPlan } from '../VerebonaCommandPlan';
import { VerebonaExplanation } from '../VerebonaExplanation';
import { useVerebonaSpace, type VerebonaSpaceApi } from './VerebonaSpaceProvider';

export type SpaceVariant = 'desktop' | 'mobile';

// ── Styles partagés ─────────────────────────────────────────────────────────

export const TONES: Record<SpaceObject['tone'], { bg: string; fg: string }> = {
  blue: { bg: 'var(--wash-blue)', fg: 'var(--on-blue)' },
  green: { bg: 'var(--wash-green)', fg: 'var(--on-green)' },
  amber: { bg: 'var(--wash-amber)', fg: 'var(--on-amber)' },
  red: { bg: 'var(--wash-red)', fg: 'var(--on-red)' },
  violet: { bg: 'var(--wash-violet)', fg: 'var(--on-violet)' },
  slate: { bg: 'var(--wash-slate)', fg: 'var(--text-muted)' },
};

export const OBJECT_ICONS: Record<SpaceObject['icon'], typeof Package> = {
  package: Package, 'file-text': FileText, 'calendar-days': CalendarDays, info: Info,
  'circle-alert': CircleAlert, building: Building2, clock: Clock,
};

const RAIL: Record<ReturnType<typeof railTone>, string> = {
  neutral: 'var(--border)',
  success: 'var(--vb-green-500)',
  error: 'var(--vb-red-500)',
};

export function pillClass(primary: boolean, variant: SpaceVariant): string {
  const size = variant === 'mobile' ? 'h-10 px-4 text-[13px]' : 'h-8 px-3.5 text-[12.5px]';
  const look = primary
    ? 'bg-[color:var(--accent)] text-white font-semibold hover:bg-[#2563EB]'
    : 'border border-[color:var(--border)] text-[color:var(--text-primary)] font-medium hover:bg-[color:var(--accent-soft)] hover:border-[color:var(--accent)]';
  return `inline-flex items-center justify-center rounded-full whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--bg-page)] disabled:opacity-50 ${size} ${look}`;
}

const SECTION_LABEL = 'text-[11px] font-semibold uppercase tracking-[.05em] text-[color:var(--text-muted)] px-0.5 pb-1';

// ── Objet ───────────────────────────────────────────────────────────────────

function ObjectRow({ o, variant, onLocal, onLeave }: { o: SpaceObject; variant: SpaceVariant; onLocal: (id: string) => void; onLeave: () => void }) {
  const Icon = OBJECT_ICONS[o.icon] ?? FileText;
  const tone = TONES[o.tone] ?? TONES.slate;
  const sub = [o.sub, o.meta].filter(Boolean).join(' · ');
  const inner = (
    <>
      <span className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-[9px]" style={{ background: tone.bg, color: tone.fg }}>
        <Icon className="h-[17px] w-[17px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13.5px] font-medium text-[color:var(--text-primary)]">{o.title}</span>
        {sub && <span className="block truncate text-[11.5px] text-[color:var(--muted-foreground)]">{sub}</span>}
      </span>
      {variant === 'desktop'
        ? <span className={pillClass(false, 'desktop')}>{o.cta}</span>
        : <span className="whitespace-nowrap text-[12px] font-semibold text-[color:var(--accent)]">{o.cta}</span>}
    </>
  );
  const cls = `flex w-full items-center gap-2.5 rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--row-muted)] px-2.5 py-[9px] ${variant === 'mobile' ? 'min-h-[54px]' : ''} transition-colors hover:border-[color:var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]`;
  if (o.actionId) {
    return <button type="button" className={cls} onClick={() => onLocal(o.actionId!)}>{inner}</button>;
  }
  if (o.href) {
    // Mobile : l'espace plein écran se ferme d'abord, sinon il masquerait le tiroir.
    return <a href={o.href} className={cls} onClick={(e) => { onLeave(); openDrawerFromLink(e, o.href); }}>{inner}</a>;
  }
  return <div className={cls}>{inner}</div>;
}

// ── Réponse ─────────────────────────────────────────────────────────────────

function Answer({ msg, variant, api }: { msg: VerebonaMessage; variant: SpaceVariant; api: VerebonaSpaceApi }) {
  const { v } = api;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [allResults, setAllResults] = useState(false);
  const [reported, setReported] = useState(false);
  const isError = Boolean(msg.error);

  const { groups, hiddenCount } = visibleResultGroups(msg.resultGroups, allResults);
  // CDC 15 T2-35 : chronologie structurée → liste « date · libellé » (mêmes
  // jetons que la réponse et les objets) ; sinon, le texte seul.
  const chrono = isError ? [] : timelineRows(msg);
  const cards = groups.flatMap((g) => g.items.map((c) => ({ ...c, groupType: g.type })));
  const objects: SpaceObject[] = [...objectsFromCards(cards), ...(msg.local?.objects ?? [])];

  const onAction = (a: VerebonaAction) => {
    switch (a.type) {
      case 'SHOW_EXPLANATION': setExplanationOpen((o) => !o); break;
      case 'RETRY_REQUEST': api.guard(() => { void v.retry(msg.id); }); break;
      default: break;
    }
  };
  // Ni « Voir les sources » ni avis 👍/👎 sous les réponses (décision produit
  // du 2 oct. 2026) : l'action SHOW_SOURCES proposée par le serveur est écartée.
  const serverActions = (msg.actions ?? []).filter((a) => a.type !== 'SHOW_SOURCES');
  // §32.3 (D-J7) : clic sur une action — type et rang seulement.
  const clicAction = (a: VerebonaAction, rang: number) =>
    trackAssistantUsage({ type: 'ACTION_CLICK', actionType: a.type, value: rang === 0 ? 'primary' : 'secondary', intent: msg.intent ?? null });
  const report = () => {
    // Réponse enregistrée côté serveur : avis « pas utile » rattaché ; sinon
    // (panne réseau, pas d'identifiant serveur), le centre d'aide.
    if (/^\d+$/.test(msg.id)) v.sendFeedback(msg.id, 'not_helpful', 'other');
    else window.dispatchEvent(new CustomEvent('verebona:report'));
    setReported(true);
  };

  return (
    <div className="flex flex-col gap-2 border-l-2 pl-3.5" style={{ borderColor: RAIL[railTone(msg)] }} role={isError ? 'alert' : undefined}>
      {chrono.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Chronologie">
          {chrono.map((e) => (
            <li key={e.key} className={`flex items-baseline gap-2 leading-normal ${variant === 'mobile' ? 'text-[15px]' : 'text-[14.5px]'}`}>
              <span className="flex-shrink-0 whitespace-nowrap text-[12px] text-[color:var(--text-muted)] tabular-nums">{e.date}</span>
              <span aria-hidden className="text-[color:var(--text-muted)]">·</span>
              {e.href ? (
                <a
                  href={e.href}
                  className="min-w-0 break-words text-[color:var(--text-primary)] underline decoration-[color:var(--border)] underline-offset-2 hover:decoration-[color:var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
                  onClick={(ev) => { api.leaveForOverlay(); openDrawerFromLink(ev, e.href!); }}
                >
                  {e.text}
                </a>
              ) : (
                <span className="min-w-0 break-words text-[color:var(--text-primary)]">{e.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {chrono.length === 0 && showAnswerText(msg) && (
        <p
          className={`m-0 whitespace-pre-line leading-normal ${variant === 'mobile' ? 'text-[15px]' : 'text-[14.5px]'}`}
          style={{ color: isError ? 'var(--on-red)' : 'var(--text-primary)' }}
          onCopy={() => trackAssistantUsage({ type: 'ANSWER_COPY', intent: msg.intent ?? null })}
        >
          {msg.content}
        </p>
      )}

      {msg.clarification && (
        <div className="flex flex-wrap gap-1.5">
          {msg.clarification.choices.map((c, i) => (
            <button
              key={c.choiceId}
              type="button"
              className={pillClass(i === 0, variant)}
              onClick={() => api.guard(() => { void v.answerClarification(msg.clarification!.clarificationId, c); })}
            >
              {c.label}{c.secondaryLabel ? ` · ${c.secondaryLabel}` : ''}
            </button>
          ))}
        </div>
      )}

      {objects.length > 0 && (
        <div className="flex flex-col gap-1.5" aria-label="Résultats">
          {objects.map((o) => <ObjectRow key={o.id} o={o} variant={variant} onLocal={api.runLocal} onLeave={api.leaveForOverlay} />)}
          {hiddenCount > 0 && !allResults && (
            <button type="button" className="self-start text-[12.5px] font-medium text-[color:var(--accent)] hover:underline" onClick={() => setAllResults(true)}>
              Voir tous les résultats
            </button>
          )}
        </div>
      )}

      {msg.commandPlan && (
        <VerebonaCommandPlan
          plan={msg.commandPlan}
          disabled={msg.commandPlan.status === 'DECIDING'}
          onConfirm={(id) => api.guard(() => { void v.confirmPlan(id); })}
          onCancel={(id) => { void v.cancelPlan(id); }}
          onUndo={(id) => api.guard(() => { void v.undoPlan(id); })}
        />
      )}

      {(serverActions.length > 0 || (msg.local?.actions?.length ?? 0) > 0 || isError) && (
        <div className="flex flex-wrap gap-1.5">
          {(msg.local?.actions ?? []).map((a) => (
            <button key={a.id} type="button" className={pillClass(!!a.primary, variant)} onClick={() => api.runLocal(a.id)}>{a.label}</button>
          ))}
          {serverActions.map((a, rang) => (
            a.href ? (
              <a key={a.actionId} href={a.href} data-analytics={a.analyticsCode} className={pillClass(false, variant)} onClick={(e) => { clicAction(a, rang); api.leaveForOverlay(); openDrawerFromLink(e, a.href); }}>
                {a.label}
              </a>
            ) : (
              <button key={a.actionId} type="button" data-analytics={a.analyticsCode} className={pillClass(a.type === 'RETRY_REQUEST', variant)} onClick={() => { clicAction(a, rang); onAction(a); }}>
                {a.label}
              </button>
            )
          ))}
          {isError && (
            <button type="button" className={pillClass(false, variant)} onClick={report} disabled={reported}>
              {reported ? 'Merci, c’est signalé' : 'Signaler un problème'}
            </button>
          )}
        </div>
      )}

      {explanationOpen && <VerebonaExplanation messageId={msg.id} />}
    </div>
  );
}

// ── Échange ─────────────────────────────────────────────────────────────────

/**
 * Traitement en cours (§6.4) : trois points, et un statut court qui suit le
 * temps écoulé (§7.7 du CDC assistant), annoncé aux lecteurs d'écran.
 */
export function ProcessingDots() {
  const [debut] = useState(() => Date.now());
  const [maintenant, setMaintenant] = useState(debut);
  useEffect(() => {
    const t = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const statut = processingStatus(maintenant - debut);
  return (
    <div className="flex h-5 items-center gap-2 pl-4" role="status" aria-live="polite">
      <span className="flex items-center gap-[5px]" aria-hidden><span className="vb-dot" /><span className="vb-dot" /><span className="vb-dot" /></span>
      <span className="text-[12px] text-[color:var(--text-muted)]">{statut}</span>
    </div>
  );
}

function Turn({ turn, variant, api }: { turn: SpaceTurn; variant: SpaceVariant; api: VerebonaSpaceApi }) {
  return (
    <div className="flex flex-col gap-2">
      {turn.question && (
        <div className="flex items-start gap-2 text-[13px] text-[color:var(--text-muted)]">
          <span className="font-semibold text-[color:var(--accent)]" aria-hidden>›</span>
          <span className="min-w-0 break-words">{turn.question}</span>
        </div>
      )}
      {turn.offline && <p className="m-0 pl-4 text-[11.5px] text-[color:var(--text-muted)]" role="status">{OFFLINE_PENDING_LABEL}</p>}
      {turn.answers.map((m) => <Answer key={m.id} msg={m} variant={variant} api={api} />)}
      {turn.pending && <ProcessingDots />}
    </div>
  );
}

// ── Corps de l'espace ───────────────────────────────────────────────────────

const LIST = 'm-0 flex list-none flex-col overflow-hidden rounded-[14px] border border-[color:var(--border-subtle)] p-0';

/** Une recherche récente : une ligne (la question), corbeille au bout, sans confirmation. */
function RecentRow({ title, first, onResume, onDelete }: { title: string; first: boolean; onResume: () => void; onDelete: () => void }) {
  return (
    <li className={`flex items-center gap-1 pr-1.5 ${first ? '' : 'border-t border-[color:var(--border-subtle)]'}`}>
      <button
        type="button"
        onClick={onResume}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:bg-[color:var(--accent-soft)] focus-visible:outline-none"
      >
        <Clock className="h-[15px] w-[15px] flex-shrink-0 text-[color:var(--text-muted)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-[color:var(--text-primary)]">{title}</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Supprimer « ${title} »`}
        title="Supprimer"
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[color:var(--text-muted)] hover:bg-[color:var(--wash-red)] hover:text-[color:var(--on-red)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Accueil du pop-up : les suggestions, puis les 3 dernières recherches
 * (une ligne chacune, corbeille au bout). Une recherche supprimée laisse
 * remonter la suivante.
 */
function InitialState({ variant, api }: { variant: SpaceVariant; api: VerebonaSpaceApi }) {
  const mobile = variant === 'mobile';
  return (
    <div className="flex flex-col gap-1.5">
      {!mobile && api.suggestions.length > 0 && <span className={SECTION_LABEL}>Par exemple</span>}
      {api.suggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => { void api.ask(s.label); }}
          className={`flex items-center gap-2.5 rounded-xl border border-[color:var(--border-subtle)] text-left text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] ${mobile ? 'min-h-11 bg-[color:var(--bg-card)] px-3.5 text-[13.5px]' : 'min-h-10 px-3 text-[13px]'}`}
        >
          <span className="font-semibold text-[color:var(--accent)]" aria-hidden>›</span>{s.label}
        </button>
      ))}
      {api.recent.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <span className={SECTION_LABEL}>Recherches récentes</span>
          <ul className={LIST} aria-label="Recherches récentes">
            {api.recent.map((r, i) => (
              <RecentRow key={r.id} first={i === 0} title={r.title} onResume={() => api.resume(r.id)} onDelete={() => api.removeRecent(r.id)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Échanges regroupés (§7.2) : une ligne « question → résumé » par échange ;
 * un clic DÉPLIE l'échange (avec ses boutons) — il ne repose
 * pas la question, ce qui pourrait préparer une seconde action.
 */
function OlderDrawer({ older, api, variant }: { older: SpaceTurn[]; api: VerebonaSpaceApi; variant: SpaceVariant }) {
  const [open, setOpen] = useState(false);
  const [deplies, setDeplies] = useState<Set<string>>(() => new Set());
  const basculer = (id: string) => setDeplies((d) => {
    const n = new Set(d);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[color:var(--border-subtle)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 items-center gap-2 bg-[color:var(--row-muted)] px-3 py-2 text-left text-[12px] text-[color:var(--text-muted)]"
      >
        <span className="flex-1">{olderLabel(older.length)}</span>
        <span className="font-medium text-[color:var(--accent)]">{open ? 'Masquer' : 'Afficher'}</span>
      </button>
      {open && older.map((t) => {
        const deplie = deplies.has(t.id);
        return (
          <div key={t.id} className="border-t border-[color:var(--border-subtle)]">
            <button
              type="button"
              aria-expanded={deplie}
              onClick={() => basculer(t.id)}
              className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)]"
            >
              <span className="max-w-[45%] truncate text-[color:var(--text-muted)]">{t.question || '…'}</span>
              <span className="text-[color:var(--text-muted)]" aria-hidden>→</span>
              <span className="min-w-0 flex-1 truncate">{turnSummary(t)}</span>
            </button>
            {deplie && <div className="px-3 pb-3 pt-1"><Turn turn={t} variant={variant} api={api} /></div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Suggestions pendant la frappe ───────────────────────────────────────────

export const LIVE_OPTION_ID = (i: number) => `verebona-suggestion-${i}`;

const LIVE_ICONS: Record<LiveResult['kind'], typeof Package> = {
  nav: ArrowRight, asset: Package, document: FileText, agenda: CalendarDays,
};
const LIVE_LABELS: Record<LiveResult['kind'], string> = { nav: 'Page', asset: 'Bien', document: 'Document', agenda: 'Échéance' };

function LiveResults({ api }: { api: VerebonaSpaceApi }) {
  if (api.live.length === 0 && !api.liveLoading) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className={SECTION_LABEL}>{api.liveLoading && api.live.length === 0 ? 'Recherche…' : 'Correspondances'}</span>
      <ul id="verebona-suggestions" role="listbox" aria-label="Correspondances" className={LIST}>
        {api.live.map((r, i) => {
          const Icon = LIVE_ICONS[r.kind];
          const actif = i === api.activeLive;
          return (
            <li
              key={r.id}
              id={LIVE_OPTION_ID(i)}
              role="option"
              aria-selected={actif}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => api.openLive(r)}
              className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 ${i > 0 ? 'border-t border-[color:var(--border-subtle)]' : ''} ${actif ? 'bg-[color:var(--accent-soft)]' : 'hover:bg-[color:var(--accent-soft)]'}`}
            >
              <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--wash-slate)] text-[color:var(--text-muted)]">
                <Icon className="h-[15px] w-[15px]" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-medium text-[color:var(--text-primary)]">{r.title}</span>
                <span className="truncate text-[11.5px] text-[color:var(--text-muted)]">{[LIVE_LABELS[r.kind], r.sub].filter(Boolean).join(' · ')}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 px-0.5 text-[11.5px] text-[color:var(--text-muted)]">
        Entrée : demander à Verebona « {api.draft.trim()} »
      </p>
    </div>
  );
}

/**
 * Corps défilant : suggestions pendant la frappe, état initial, tiroir des échanges regroupés, derniers échanges. Se place sur le
 * dernier échange (ou sur les suggestions, du côté du champ).
 */
export function SpaceBody({ variant, scrollRef }: { variant: SpaceVariant; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const api = useVerebonaSpace();
  // Accueil du pop-up : l'échange n'est affiché qu'après une question ou une reprise.
  const turns = api?.showThread ? api.turns : [];
  const { recent, older } = splitTurns(turns);
  const last = turns[turns.length - 1];
  const saisie = (api?.live.length ?? 0) > 0;
  const signature = `${turns.length}:${last?.answers.length ?? 0}:${last?.pending ? 1 : 0}:${saisie ? 1 : 0}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Desktop : le champ est au-dessus, les suggestions en tête ; sinon le dernier échange.
    el.scrollTop = saisie && variant === 'desktop' ? 0 : el.scrollHeight;
  }, [signature, scrollRef, saisie, variant]);

  if (!api) return null;
  const suggestions = <LiveResults api={api} />;
  return (
    <>
      {variant === 'desktop' && suggestions}
      {turns.length === 0 && !saisie && <InitialState variant={variant} api={api} />}
      {api.v.hasOlder && turns.length > 0 && (
        <button
          type="button"
          onClick={() => { void api.v.loadOlder(); }}
          disabled={api.v.loadingOlder}
          className="self-center text-[12px] font-medium text-[color:var(--accent)] disabled:opacity-50"
        >
          {api.v.loadingOlder ? 'Chargement…' : 'Afficher les messages plus anciens'}
        </button>
      )}
      {older.length > 0 && <OlderDrawer older={older} api={api} variant={variant} />}
      <div aria-live="polite" className="flex flex-col gap-4">
        {recent.map((t) => <Turn key={t.id} turn={t} variant={variant} api={api} />)}
      </div>
      {variant === 'mobile' && suggestions}
    </>
  );
}
