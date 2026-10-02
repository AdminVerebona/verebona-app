'use client';
/**
 * Le champ Verebona — Direction D v2 §4.1, §5, §6.2, §6.3.
 *
 * Desktop : pilule centrée dans le header, 420 px au repos, 640 px quand
 * l'espace est ouvert ; le panneau de réponse est accroché dessous.
 * Mobile : pilule de 46 px dans la barre haute ; un tap ouvre l'espace en
 * plein écran, champ ancré en bas.
 *
 * Un seul champ pour chercher et demander : la frappe propose les biens,
 * documents, échéances et pages qui correspondent (flèches pour choisir,
 * Entrée pour ouvrir) ; Entrée sans suggestion choisie envoie la demande à
 * Verebona.
 *
 * L'espace s'ouvre au clic, au raccourci ⌘K ou à la frappe — jamais au
 * simple focus (voir `VerebonaSpaceProvider`, « Ouvrir n'est pas écrire »).
 */
import { useRef, useState } from 'react';
import { ArrowRight, History, Square, X } from 'lucide-react';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { composerState } from '@/lib/verebona/offline';
import { exchangeCountLabel, fieldPlaceholder } from '@/lib/verebona/space';
import { MascotPose } from './MascotPose';
import { SpaceBody, LIVE_OPTION_ID } from './SpaceContent';
import { useVerebonaSpace, type VerebonaSpaceApi } from './VerebonaSpaceProvider';

export const PANEL_ID = 'verebona-espace';
export const LIVE_LIST_ID = 'verebona-suggestions';

/** Saisie partagée, envoi (Entrée), restauration si la demande n'aboutit pas. */
function useFieldText(api: VerebonaSpaceApi | null) {
  const text = api?.draft ?? '';
  const courant = useRef(text);
  courant.current = text;
  const etat = composerState(api?.v.online ?? true, api?.v.isLoading ?? false, text);
  const submit = () => {
    if (!api || !etat.canSend) return;
    const envoye = text.trim();
    const r = api.ask(envoye);
    if (r === false) return; // refusée : le texte reste dans le champ
    api.setDraft('');
    void r.then((ok) => { if (!ok && !courant.current.trim()) api.setDraft(envoye); });
  };
  /** Flèches : suggestions ; Entrée : suggestion choisie, sinon la demande. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!api || e.nativeEvent.isComposing) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && api.live.length > 0) {
      e.preventDefault();
      api.moveLive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const choisie = api.activeLive >= 0 ? api.live[api.activeLive] : null;
      if (choisie) api.openLive(choisie);
      else submit();
    }
  };
  const a11y = api && api.live.length > 0
    ? { 'aria-autocomplete': 'list' as const, 'aria-activedescendant': api.activeLive >= 0 ? LIVE_OPTION_ID(api.activeLive) : undefined }
    : {};
  return { text, submit, etat, onKeyDown, a11y };
}

function SendButton({ api, canSend, onSend, size }: { api: VerebonaSpaceApi; canSend: boolean; onSend: () => void; size: number }) {
  if (api.v.isLoading) {
    return (
      <button
        type="button"
        onClick={api.v.cancel}
        aria-label="Arrêter la demande"
        className="flex flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--muted)] text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--accent-soft)]"
        style={{ width: size, height: size }}
      >
        <Square className="h-3 w-3" fill="currentColor" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSend}
      aria-label="Envoyer"
      aria-disabled={!canSend}
      className="flex flex-shrink-0 items-center justify-center rounded-full transition-colors duration-150"
      style={{ width: size, height: size, background: canSend ? 'var(--accent)' : 'var(--muted)', color: canSend ? '#fff' : 'var(--text-muted)' }}
    >
      <ArrowRight className="h-[15px] w-[15px]" strokeWidth={2.2} aria-hidden />
    </button>
  );
}

/** Bouton « Toutes les demandes » (historique complet des fils, §8). */
function HistoryButton({ api, size }: { api: VerebonaSpaceApi; size: 'desktop' | 'mobile' }) {
  const on = api.historyOpen;
  return (
    <button
      type="button"
      onClick={() => api.setHistoryOpen(!on)}
      aria-pressed={on}
      aria-label={on ? 'Revenir à l’échange' : 'Toutes les demandes'}
      title={on ? 'Revenir à l’échange' : 'Toutes les demandes'}
      className={`flex items-center justify-center rounded-[10px] transition-colors hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)] ${size === 'mobile' ? 'h-11 w-10' : 'h-9 w-9'} ${on ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'}`}
    >
      <History className="h-4 w-4" aria-hidden />
    </button>
  );
}

// ── Desktop ─────────────────────────────────────────────────────────────────

export function VerebonaHeaderField() {
  const api = useVerebonaSpace();
  const { text, submit, etat, onKeyDown, a11y } = useFieldText(api);
  const [focused, setFocused] = useState(false);
  if (!api) return null;
  // Échange affiché seulement après une question ou une reprise (accueil du pop-up sinon).
  const n = api.showThread ? api.turns.length : 0;
  const actif = focused || api.isOpen;
  const idle = !api.isOpen;

  return (
    <div
      className="absolute left-1/2 top-[9px] z-[32] flex h-[42px] -translate-x-1/2 items-center gap-2 rounded-full border pl-3 pr-[5px] transition-all duration-[250ms]"
      title={etat.notice ?? undefined}
      style={{
        width: api.isOpen ? 'min(640px, calc(100% - 150px))' : 'min(420px, calc(100% - 170px))',
        background: 'var(--field-bg)',
        borderColor: actif ? 'var(--accent)' : 'var(--border)',
        boxShadow: actif ? '0 0 0 3px rgba(59,130,246,.22)' : '0 0 0 0 transparent',
      }}
    >
      <button
        type="button"
        onClick={api.toggle}
        aria-label={api.isOpen ? 'Fermer l’espace Verebona' : 'Ouvrir l’espace Verebona'}
        className="flex flex-shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
      >
        <MascotPose pose={api.pose} size={26} priority />
      </button>
      <input
        ref={api.registerInput}
        type="text"
        role="combobox"
        aria-expanded={api.isOpen}
        aria-controls={api.live.length > 0 ? LIVE_LIST_ID : PANEL_ID}
        aria-label="Demander à Verebona"
        aria-keyshortcuts="Meta+K Control+K"
        {...a11y}
        value={text}
        maxLength={2000}
        onChange={(e) => { api.setDraft(e.target.value); if (!api.isOpen) api.open(); }}
        // Au clic (et non au focus) : un focus rendu par une fenêtre qui se
        // ferme ne rouvre jamais l'espace.
        onClick={() => { if (!api.isOpen) api.open(); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={fieldPlaceholder(n)}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-muted)]"
      />
      {idle && !text && (
        <kbd className="rounded-md bg-[color:var(--muted)] px-[7px] py-0.5 font-sans text-[10.5px] text-[color:var(--text-muted)]" aria-hidden>⌘K</kbd>
      )}
      <SendButton api={api} canSend={etat.canSend} onSend={submit} size={34} />
    </div>
  );
}

/**
 * Panneau superposé sous le champ (§6.2) : 640 px, rayon 24, voile derrière
 * (clic = fermeture), hauteur bornée, contenu défilant sur le dernier échange.
 */
export function VerebonaDesktopPanel() {
  const api = useVerebonaSpace();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (!api || !api.isOpen || !api.isDesktop) return null;
  const n = api.showThread ? api.turns.length : 0;
  const notice = composerState(api.v.online, false, '').notice;
  return (
    <>
      <div
        className="absolute inset-0 z-[30] bg-[color:var(--veil)] [animation:vb-fade_.2s_ease-out]"
        onClick={api.close}
        aria-hidden
      />
      <section
        id={PANEL_ID}
        role="dialog"
        aria-modal="false"
        aria-label="Verebona"
        className="absolute left-1/2 top-[66px] z-[31] flex w-[min(640px,calc(100%-32px))] -translate-x-1/2 flex-col rounded-[24px] border [animation:vb-rise_.3s_cubic-bezier(.16,1,.3,1)]"
        // Lavis de carte posé sur le fond de page : le panneau reste opaque
        // (la page assombrie ne doit pas transparaître sous le texte).
        style={{ maxHeight: 'calc(100% - 100px)', borderColor: 'rgba(59,130,246,.28)', boxShadow: 'var(--vb-shadow-panel)', background: 'linear-gradient(var(--bg-card), var(--bg-card)), var(--bg-page)' }}
      >
        <header className="flex flex-shrink-0 items-center gap-2.5 border-b border-[color:var(--border-subtle)] py-2.5 pl-[18px] pr-3">
          <span className="text-[13px] font-semibold text-[color:var(--text-primary)]">Verebona</span>
          <span className="text-[12px] text-[color:var(--text-muted)]">{api.historyOpen ? 'Toutes les demandes' : exchangeCountLabel(n)}</span>
          <div className="ml-auto flex items-center gap-1">
            {n > 0 && !api.historyOpen && (
              <button type="button" onClick={api.newRequest} className="h-8 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)]">
                Nouvelle demande
              </button>
            )}
            <HistoryButton api={api} size="desktop" />
            <button
              type="button"
              onClick={api.close}
              aria-label="Fermer"
              className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </header>
        {notice && (
          <p role="status" className="m-0 flex-shrink-0 border-b border-[color:var(--border-subtle)] px-[18px] py-2 text-[12px] text-[color:var(--on-amber)]">{notice}</p>
        )}
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pb-5 pt-4">
          <SpaceBody variant="desktop" scrollRef={scrollRef} />
        </div>
      </section>
    </>
  );
}

// ── Mobile ──────────────────────────────────────────────────────────────────

/** Pilule de la barre haute mobile (§4.1). */
export function VerebonaMobileField() {
  const api = useVerebonaSpace();
  if (!api) return null;
  return (
    <button
      type="button"
      onClick={api.open}
      aria-label="Demander à Verebona"
      aria-controls={PANEL_ID}
      aria-expanded={api.isOpen}
      aria-haspopup="dialog"
      className="flex h-[46px] min-w-0 flex-1 items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--field-bg)] pl-2.5 pr-1.5 text-left text-[14px] text-[color:var(--text-muted)]"
    >
      <MascotPose pose={api.pose} size={28} priority />
      <span className="min-w-0 flex-1 truncate">Demander à Verebona</span>
      <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-[color:var(--muted)] text-[color:var(--text-primary)]">
        <ArrowRight className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      </span>
    </button>
  );
}

/**
 * Espace plein écran mobile (§6.3), champ ancré en bas au-dessus du clavier.
 * Fenêtre modale : le focus y est piégé et revient à la pilule à la fermeture.
 */
export function VerebonaMobileSpace() {
  const api = useVerebonaSpace();
  const { text, submit, etat, onKeyDown, a11y } = useFieldText(api);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (!api || !api.isOpen || api.isDesktop) return null;
  const n = api.showThread ? api.turns.length : 0;
  return (
    <FocusScope trapped loop asChild>
      <section
        id={PANEL_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Verebona"
        className="fixed inset-0 z-[70] flex flex-col bg-[color:var(--bg-page)] pt-[env(safe-area-inset-top)] [animation:vb-slide-up_.3s_cubic-bezier(.16,1,.3,1)]"
        style={{ height: '100dvh' }}
      >
        <header className="flex flex-shrink-0 items-center gap-1.5 border-b border-[color:var(--border-subtle)] px-3.5 pb-2.5 pt-1">
          <button type="button" onClick={api.close} aria-label="Fermer" className="-ml-2 flex h-11 w-11 items-center justify-center text-[color:var(--text-primary)]">
            <X className="h-5 w-5" aria-hidden />
          </button>
          <div className="min-w-0 flex-1 text-right">
            <div className="truncate text-[14px] font-semibold text-[color:var(--text-primary)]">
              {api.historyOpen ? 'Toutes les demandes' : n ? 'Verebona' : 'Que puis-je faire pour vous aujourd’hui ?'}
            </div>
            <div className="text-[11.5px] text-[color:var(--text-muted)]">{exchangeCountLabel(n) || 'Rechercher, retrouver ou demander…'}</div>
          </div>
          {n > 0 && !api.historyOpen && (
            <button type="button" onClick={api.newRequest} className="h-11 whitespace-nowrap px-1 text-[12.5px] font-medium text-[color:var(--accent)]">
              Nouvelle demande
            </button>
          )}
          <HistoryButton api={api} size="mobile" />
          <MascotPose pose={api.pose} size={46} style={{ filter: 'drop-shadow(0 8px 12px rgba(4,10,26,.5))' }} />
        </header>
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[18px] pb-3 pt-4">
          <SpaceBody variant="mobile" scrollRef={scrollRef} />
        </div>
        <div className="flex-shrink-0 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] px-3.5 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5">
          {etat.notice && <p role="status" className="mb-2 text-[12px] text-[color:var(--on-amber)]">{etat.notice}</p>}
          <div
            className="flex h-12 items-center gap-2 rounded-full border pl-4 pr-1.5"
            style={{ background: 'var(--field-bg)', borderColor: 'var(--accent)', boxShadow: '0 0 0 3px rgba(59,130,246,.2)' }}
          >
            <input
              ref={api.registerInput}
              type="text"
              role="combobox"
              aria-expanded={api.live.length > 0}
              aria-controls={LIVE_LIST_ID}
              aria-label="Demander à Verebona"
              {...a11y}
              value={text}
              maxLength={2000}
              enterKeyHint="send"
              onChange={(e) => api.setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={n ? 'Poursuivre…' : 'Rechercher, retrouver ou demander…'}
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-[16px] text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-muted)]"
            />
            <SendButton api={api} canSend={etat.canSend} onSend={submit} size={38} />
          </div>
        </div>
      </section>
    </FocusScope>
  );
}
