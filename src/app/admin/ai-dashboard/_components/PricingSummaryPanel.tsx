'use client';

/**
 * Synthèse TARIFAIRE groupée — lot 113O (carte #713, critère 9).
 *
 * Remplace la succession de bandeaux « Tarif IA inconnu … » / « Appels IA non
 * chiffrés … » (une alerte par modèle et par jour) par UN bloc : niveau de
 * sévérité, compteurs des trois risques distincts (chaînes actives sans
 * tarif, appels historiques non chiffrés, tarifs non confirmés / source
 * rejetée), détail repliable par modèle avec sa cause factuelle, alertes
 * résolues récemment (historique consultable), liens vers Fournisseur IA ›
 * Tarifs et Coûts IA › Appels non chiffrés. Aucun risque actuel n'est masqué.
 *
 * Même rendu desktop et mobile (grille 2 → 4 colonnes, contenu en
 * `flex-wrap`, `break-words`). Jetons de la charte Sérénité uniquement.
 */
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';

export interface PricingSummaryView {
  severity: 'ok' | 'info' | 'warning' | 'critical';
  title: string;
  evaluatedAt: string;
  counters: { activeUnpriced: number; unpricedCalls: number; unpricedCallModels: number; stale: number; sourceFailed: boolean; openAlerts: number; resolvedRecently: number };
  active: Array<{ model: string; usages: string; cause: string }>;
  calls: Array<{ model: string; calls: number; lastAt: string; priceNow: boolean; inActiveChain: boolean }>;
  stale: string[];
  source: { at: string; code: string | null; reason: string | null } | null;
  recentlyResolved: Array<{ id: number; code: string; message: string; resolvedAt: string | null; resolutionCode: string | null; resolutionReason: string | null }>;
  links: { pricing: string; costs: string; regularization: string };
}

const STYLE: Record<PricingSummaryView['severity'], string> = {
  critical: 'border-[color:var(--border-danger)] bg-[color:var(--bg-danger)]',
  warning: 'border-[color:var(--border-warning)] bg-[color:var(--bg-warning)]',
  info: 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]',
  ok: 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]',
};
const TITRE: Record<PricingSummaryView['severity'], string> = {
  critical: 'text-[color:var(--text-danger)]',
  warning: 'text-[color:var(--text-warning-soft)]',
  info: 'text-[color:var(--text-primary)]',
  ok: 'text-[color:var(--text-primary)]',
};
const jour = (d: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');

function Compteur({ valeur, libelle, alerte }: { valeur: number | string; libelle: string; alerte: boolean }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-2 min-w-0">
      <p className={`text-lg font-semibold ${alerte ? 'text-[color:var(--text-warning-soft)]' : 'text-[color:var(--text-primary)]'}`}>{valeur}</p>
      <p className="text-[11px] leading-tight text-[color:var(--text-muted)] break-words">{libelle}</p>
    </div>
  );
}

export function PricingSummaryPanel({ summary }: { summary: PricingSummaryView }) {
  const s = summary;
  if (s.severity === 'ok' && s.counters.resolvedRecently === 0) return null;
  const Icone = s.severity === 'ok' ? CheckCircle2 : s.severity === 'info' ? Info : AlertTriangle;
  return (
    <section data-testid="pricing-summary" aria-label="Synthèse de la tarification IA"
      className={`rounded-xl border p-3 sm:p-4 space-y-3 ${STYLE[s.severity]}`}>
      <p className={`text-sm font-semibold flex items-start gap-1.5 ${TITRE[s.severity]}`}>
        <Icone className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
        <span className="break-words">{s.title}</span>
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Compteur valeur={s.counters.activeUnpriced} libelle="Chaînes actives sans tarif (appels futurs)" alerte={s.counters.activeUnpriced > 0} />
        <Compteur valeur={s.counters.unpricedCalls} libelle={`Appels historiques non chiffrés (${s.counters.unpricedCallModels} modèle(s))`} alerte={s.counters.unpricedCalls > 0} />
        <Compteur valeur={s.counters.stale} libelle="Tarifs non confirmés (STALE)" alerte={false} />
        <Compteur valeur={s.counters.sourceFailed ? 'Rejetée' : 'Lue'} libelle="Page officielle Google" alerte={s.counters.sourceFailed} />
      </div>

      {s.active.length > 0 && (
        <details open className="text-xs">
          <summary className="cursor-pointer font-medium text-[color:var(--text-primary)]">Modèles de chaînes actives sans tarif ({s.active.length})</summary>
          <ul className="mt-1 space-y-1">
            {s.active.map((a) => (
              <li key={a.model} className="break-words text-[color:var(--text-secondary)]">
                <code className="font-semibold text-[color:var(--text-primary)] break-all">{a.model}</code> · {a.usages} — {a.cause}
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.calls.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-[color:var(--text-primary)]">Appels historiques non chiffrés, à régulariser ({s.counters.unpricedCalls})</summary>
          <ul className="mt-1 space-y-1">
            {s.calls.map((c) => (
              <li key={c.model} className="break-words text-[color:var(--text-secondary)]">
                <code className="text-[color:var(--text-primary)] break-all">{c.model}</code> · {c.calls} appel(s), dernier le {jour(c.lastAt)}
                {' — '}{c.priceNow ? 'tarif désormais applicable : simulation possible' : 'aucun tarif applicable prouvé'}
                {c.inActiveChain ? '' : ' · hors chaînes actives'}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(s.stale.length > 0 || s.source) && (
        <p className="text-xs text-[color:var(--text-secondary)] break-words">
          {s.source && <>Dernière lecture de la page officielle rejetée le {jour(s.source.at)} ({s.source.code ?? '—'}) : tarifs connus conservés, aucun retrait. </>}
          {s.stale.length > 0 && <>Non confirmés : {s.stale.join(', ')}.</>}
        </p>
      )}
      {s.recentlyResolved.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[color:var(--text-muted)]">Alertes tarifaires résolues récemment ({s.recentlyResolved.length})</summary>
          <ul className="mt-1 space-y-1">
            {s.recentlyResolved.map((r) => (
              <li key={r.id} className="break-words text-[color:var(--text-muted)]">
                {jour(r.resolvedAt)} · {r.resolutionCode === 'SUPERSEDED' ? 'regroupée' : 'résolue'} — {r.message}
                {r.resolutionReason ? ` (${r.resolutionReason})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link href={s.links.pricing} className="inline-flex items-center gap-1 text-[color:var(--accent)] hover:underline">
          Fournisseur IA › Tarifs <ArrowRight className="w-3 h-3" aria-hidden />
        </Link>
        <Link href={s.links.costs} className="inline-flex items-center gap-1 text-[color:var(--accent)] hover:underline">
          Coûts IA › Appels non chiffrés <ArrowRight className="w-3 h-3" aria-hidden />
        </Link>
        <span className="text-[color:var(--text-muted)]">Recontrôlé le {new Date(s.evaluatedAt).toLocaleString('fr-FR')}</span>
      </div>
    </section>
  );
}
