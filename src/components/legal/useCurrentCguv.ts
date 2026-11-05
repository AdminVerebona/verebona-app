'use client';

/**
 * Lot 111O — version des CGUV présentée par un formulaire d'inscription
 * (classique, Google / Apple), avec REPRISE AUTOMATIQUE.
 *
 *   · Version acceptable (texte vérifié sur le site public) : figée pour tout
 *     le parcours (CDC 7 §18 — c'est la version vue qui est enregistrée).
 *   · Version NON acceptable (blocage) : la page se réévalue seule — au
 *     retour sur l'onglet, au retour du réseau, et à intervalles croissants —
 *     sans vider le navigateur ni recharger. Chaque relecture interroge le
 *     serveur (`cache: 'no-store'`), qui relance lui-même, au plus une fois
 *     par intervalle, la lecture du manifeste du site public.
 *   · `markUnavailable()` : le serveur a refusé l'inscription
 *     (`CGUV_PUBLIC_TEXT_UNAVAILABLE`) alors que la page croyait la version
 *     acceptable → relecture immédiate et passage en état de blocage.
 *
 * Aucune substitution : quand la version change (ex. 2026-07-30-v1 bloquée →
 * 2026-10-30-v1 vérifiée), c'est la NOUVELLE version qui est affichée, et
 * l'appelant remet la case à zéro (`versionCode` change).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cguvAcceptable } from './CguvPublicTextNotice';

export interface CurrentCguvView {
  versionCode: string;
  /** URL publique de la version exacte (`null` si non vérifiée). */
  permalink: string | null;
  available: boolean;
  /** Lien « Confidentialité » résolu par le serveur au même instant (sinon `null`). */
  confidentialite: string | null;
}

/** Délais de relecture en état de blocage (ms) — le dernier se répète. */
export const CGUV_RECHECK_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);

/** Pur : délai avant la `attempt`-ième relecture automatique (0, 1, 2…). */
export function nextCguvRecheckDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(CGUV_RECHECK_DELAYS_MS.length - 1, Math.floor(attempt)));
  return CGUV_RECHECK_DELAYS_MS[i];
}

/** Pur : réponse de `/api/legal/cguv/current` → vue (null : réponse inexploitable). */
export function toCurrentCguvView(data: unknown): CurrentCguvView | null {
  const d = data as { versionCode?: unknown; permalinkUrl?: unknown; permalink?: unknown; publicText?: unknown; legalLinks?: { confidentialite?: unknown } } | null;
  if (!d || typeof d.versionCode !== 'string' || !d.versionCode) return null;
  const available = cguvAcceptable(d);
  const link = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null);
  return {
    versionCode: d.versionCode,
    permalink: available ? link(d.permalinkUrl) ?? link(d.permalink) : null,
    available,
    confidentialite: link(d.legalLinks?.confidentialite),
  };
}

export async function fetchCurrentCguv(): Promise<CurrentCguvView | null> {
  try {
    const r = await fetch('/api/legal/cguv/current', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    return toCurrentCguvView(await r.json());
  } catch {
    return null;
  }
}

export function useCurrentCguv(): {
  cguv: CurrentCguvView | null;
  checking: boolean;
  retry: () => void;
  markUnavailable: () => void;
} {
  const [cguv, setCguv] = useState<CurrentCguvView | null>(null);
  const [checking, setChecking] = useState(false);
  const attempt = useRef(0);
  const alive = useRef(true);
  const busy = useRef(false);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    const next = await fetchCurrentCguv();
    busy.current = false;
    if (!alive.current) return;
    setChecking(false);
    // Réponse inexploitable (réseau, 503) : rien n'est inventé — le serveur tranche à l'envoi.
    if (!next) return;
    setCguv((prev) => {
      // Version acceptable déjà présentée : figée (§18), sauf relecture forcée après un refus serveur.
      if (prev?.available && !opts.force) return prev;
      return next;
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    void load({ force: true });
    return () => { alive.current = false; };
  }, [load]);

  // Reprise automatique : seulement en état de blocage.
  const blocked = cguv?.available === false;
  useEffect(() => {
    if (!blocked) { attempt.current = 0; return; }
    const timer = setTimeout(() => { attempt.current += 1; void load({ force: true }); }, nextCguvRecheckDelayMs(attempt.current));
    const onVisible = () => { if (document.visibilityState === 'visible') void load({ force: true }); };
    const onOnline = () => { void load({ force: true }); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
    };
    // `cguv` dans les dépendances : chaque relecture (même identique) réarme le minuteur suivant.
  }, [blocked, cguv, load]);

  const retry = useCallback(() => { void load({ force: true }); }, [load]);
  const markUnavailable = useCallback(() => {
    setCguv((prev) => (prev ? { ...prev, available: false, permalink: null } : prev));
    void load({ force: true });
  }, [load]);

  return { cguv, checking, retry, markUnavailable };
}
