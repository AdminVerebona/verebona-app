"use client"

/**
 * Lot 109C — présentation des diagnostics du coût de possession (ticket P2
 * « TCO — alertes contextualisées et actionnables »). Aucun calcul ici : la
 * nature, le nombre, les sources et l'action viennent du serveur
 * (`tco/diagnostics.ts`, via le DTO). Aucune IA, aucune lecture de document
 * à l'affichage ; jamais de carte « À traiter ».
 *
 *   · « Points à vérifier » (`TcoOpenDiagnostics`) : seulement les cas
 *     OUVERTS (anomalie à corriger, information manquante), une famille par
 *     cas avec son nombre exact, ce que le cas peut fausser, et l'accès à
 *     chaque source (justificatif, dépense, champ de la fiche) ;
 *   · « Bon à savoir » (`TcoInformationDiagnostics`) : exclusions normales et
 *     états neutres, ton neutre, renvoi au détail des dépenses.
 *   · Lot 111V : chaque source d'un cas ouvert porte ses GESTES contextuels
 *     (serveur) — confirmer le même fait, dépenses distinctes, confirmer
 *     l'exclusion, confirmer la nature, corriger le document — et, pour un
 *     doublon, la dépense comptée à sa place (date, montant retenu) ;
 *     « Vos choix confirmés » (`TcoDecidedDiagnostics`) : groupe distinct,
 *     réversible (« Annuler mon choix »). Lecture seule : aucun geste.
 *   · Lot 113N : « Dépenses sans date établie » — chaque dépense retenue non
 *     datée propose « Conserver dans le TCO sans date », « Renseigner la date »
 *     (si sa date se saisit) et « Retirer du TCO » ; une dépense confirmée
 *     passe dans « Vos choix confirmés » (annulable), le compteur des choix à
 *     faire est celui du serveur.
 * Accessible : libellés de nature écrits (la couleur n'est jamais seule),
 * listes sémantiques, cibles de 44 px sur mobile. Desktop et mobile : même
 * composant, retour à la ligne.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, FileQuestion, Info, PencilLine } from 'lucide-react';
import type { TcoDiagnostic, TcoDiagnosticImpact, TcoDiagnosticSource, TcoDiagnostics } from '@/services/business-operations/tco/diagnostics';
import { TcoJustificatif } from './tco-justificatif';
import { TcoDecisionActions, type TcoArbitrate } from './tco-decision-actions';

/** Lot 111V : contexte des gestes (absent : lecture seule, aucun geste). */
export interface TcoDiagnosticsDecide {
  onDecide: TcoArbitrate;
  categoryLabels: Readonly<Record<string, string>>;
  categories: readonly string[];
}

/** Sources montrées d'emblée par famille (les autres : « Afficher les N autres »). */
const SOURCES_VISIBLES = 3;

const IMPACT: Record<TcoDiagnosticImpact, string | null> = {
  TOTAL: 'Peut modifier le coût total',
  SCOPE: 'Peut modifier les dépenses attribuées au bien',
  PERIOD: 'Concerne la période de possession (coût annuel moyen)',
  ANNUAL: 'Concerne la répartition par année',
  NONE: null,
};

function eur(cents: number | null | undefined): string {
  return cents == null ? '' : (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

/** Ouvre le champ de la fiche du bien (section « Informations » de la page, sinon lien profond). */
function LienChamp({ assetId, field, label }: { assetId: number; field: string; label: string }) {
  const href = `/assets/${assetId}?tab=details&highlight=${encodeURIComponent(field)}`;
  return (
    <a
      href={href}
      onClick={(e) => {
        const el = document.getElementById('asset-section-common');
        if (!el || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
      className="inline-flex min-h-[44px] md:min-h-0 items-center gap-1 text-xs text-primary hover:underline"
      data-tco-diagnostic-field={field}
    >
      <PencilLine className="w-3 h-3 shrink-0" aria-hidden /> {label}
    </a>
  );
}

function dateFr(d: string | null | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null;
}

function Source({ s, d, assetId, onShowLine, decide }: { s: TcoDiagnosticSource; d: TcoDiagnostic; assetId: number; onShowLine: (s: TcoDiagnosticSource) => void; decide?: TcoDiagnosticsDecide }) {
  return (
    <li className="py-1.5 min-w-0" data-tco-diagnostic-source={s.lineId ?? s.fileId ?? s.assetField ?? ''}>
      <div className="flex items-start justify-between gap-3 text-xs">
        <span className="min-w-0 break-words text-[color:var(--text-primary)]">{s.label}</span>
        {s.amountCents != null && <span className="shrink-0 tabular-nums text-muted-foreground">{eur(s.amountCents)}</span>}
      </div>
      {s.detail && <p className="text-xs text-muted-foreground break-words">{s.detail}</p>}
      {/* Lot 111V : doublon présumé — les deux justificatifs, leurs dates et le coût retenu, pour comparer. */}
      {s.counterpart && (
        <p className="text-xs text-muted-foreground break-words" data-tco-diagnostic-counterpart>
          {`Comptée à sa place : « ${s.counterpart.label} »${dateFr(s.counterpart.date) ? `, ${dateFr(s.counterpart.date)}` : ''}${s.counterpart.amountCents != null ? `, ${eur(s.counterpart.amountCents)} retenus` : ''}${dateFr(s.date) ? ` · cette ligne : ${dateFr(s.date)}` : ''}.`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <TcoJustificatif fileId={s.fileId} />
        {s.relatedFileId != null && s.relatedFileId !== s.fileId && <TcoJustificatif fileId={s.relatedFileId} title="autre justificatif" />}
        {s.lineId && s.visible && (
          <button type="button" onClick={() => onShowLine(s)} className="inline-flex min-h-[44px] md:min-h-0 items-center gap-1 text-xs text-primary hover:underline" data-tco-diagnostic-show-line={s.lineId}>
            <ChevronRight className="w-3 h-3 shrink-0" aria-hidden /> Voir la dépense
          </button>
        )}
        {s.counterpart?.fileId != null && s.counterpart.fileId !== s.fileId && s.counterpart.fileId !== s.relatedFileId && <TcoJustificatif fileId={s.counterpart.fileId} title="dépense comptée" />}
        {s.assetField && d.action?.kind === 'ASSET_FIELD' && <LienChamp assetId={assetId} field={s.assetField} label={d.action.label} />}
      </div>
      {decide && s.lineId && (s.actions ?? []).length > 0 && (
        <TcoDecisionActions lineId={s.lineId} lineKey={s.lineKey ?? null} lineVersion={s.lineVersion ?? null} options={s.actions ?? []} onDecide={decide.onDecide} categoryLabels={decide.categoryLabels} categories={decide.categories} />
      )}
    </li>
  );
}

function Sources({ d, assetId, onShowLine, decide }: { d: TcoDiagnostic; assetId: number; onShowLine: (s: TcoDiagnosticSource) => void; decide?: TcoDiagnosticsDecide }) {
  const [tout, setTout] = useState(false);
  if (!d.sources.length) return null;
  const montrees = tout ? d.sources : d.sources.slice(0, SOURCES_VISIBLES);
  const reste = (d.count ?? d.sources.length) - montrees.length;
  return (
    <>
      <ul className="divide-y divide-border" aria-label={`Éléments concernés : ${d.title}`}>
        {montrees.map((s, i) => <Source key={`${s.lineId ?? s.fileId ?? s.assetField ?? 'x'}:${i}`} s={s} d={d} assetId={assetId} onShowLine={onShowLine} decide={decide} />)}
      </ul>
      {!tout && d.sources.length > SOURCES_VISIBLES && (
        <button type="button" onClick={() => setTout(true)} className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs text-primary hover:underline" data-tco-diagnostic-more>
          Afficher les {reste} autre(s)
        </button>
      )}
      {tout && d.sourcesTruncated && (
        <p className="text-xs text-muted-foreground">Et {reste} autre(s) : voir le détail des dépenses.</p>
      )}
    </>
  );
}

/** Lot 109C : « Points à vérifier » — cas ouverts seulement (le parent ne l'affiche que s'il y en a). */
export function TcoOpenDiagnostics({ diagnostics, assetId, onShowLine, decide }: { diagnostics: TcoDiagnostics; assetId: number; onShowLine: (s: TcoDiagnosticSource) => void; decide?: TcoDiagnosticsDecide }) {
  const ouverts = diagnostics.items.filter((d) => d.status === 'OPEN');
  if (!ouverts.length) return null;
  const { anomalies, coverage, occurrences } = diagnostics.open;
  const aDecider = diagnostics.open.decisions ?? 0;
  const parties = [
    anomalies ? `${anomalies} anomalie${anomalies > 1 ? 's' : ''} à corriger` : null,
    coverage ? `${coverage} information${coverage > 1 ? 's' : ''} manquante${coverage > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-2" data-tco-diagnostics-open={ouverts.length}>
      <p className="text-xs text-muted-foreground" data-tco-diagnostics-summary>
        {parties.join(', ')}{occurrences ? ` · ${occurrences} élément(s) concerné(s)` : ''}{aDecider ? ` · ${aDecider} choix à faire` : ''}. Les plus importants d’abord.
      </p>
      <ul className="space-y-2">
        {ouverts.map((d) => {
          const anomalie = d.nature === 'ANOMALY';
          const Icone = anomalie ? AlertTriangle : FileQuestion;
          const impact = IMPACT[d.impact];
          return (
            <li
              key={d.code}
              className={`rounded-lg border px-4 py-3 space-y-1.5 ${anomalie ? 'border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)]' : 'border-border bg-muted/30'}`}
              data-tco-diagnostic={d.code}
              data-tco-diagnostic-nature={d.nature}
              data-tco-diagnostic-count={d.count ?? ''}
            >
              <p className="text-sm font-medium flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Icone className={`w-4 h-4 shrink-0 ${anomalie ? 'text-[color:var(--attention-on-soft)]' : 'text-muted-foreground'}`} aria-hidden />
                <span className="text-xs font-semibold text-muted-foreground">{anomalie ? 'À corriger' : 'Information manquante'}</span>
                <span className="text-[color:var(--text-primary)]">{d.title}{d.count != null && d.count > 1 ? ` (${d.count})` : ''}</span>
              </p>
              <p className="text-xs text-muted-foreground">{d.text}</p>
              {impact && <p className="text-xs text-muted-foreground" data-tco-diagnostic-impact={d.impact}>{impact}{d.amountCents ? ` · ${eur(d.amountCents)} en jeu` : ''}.</p>}
              <Sources d={d} assetId={assetId} onShowLine={onShowLine} decide={decide} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Lot 109C : informations neutres (exclusions normales, déduplication prouvée, vos choix) — jamais une alerte. */
export function TcoInformationDiagnostics({ diagnostics, onShowLine }: { diagnostics: TcoDiagnostics; onShowLine: (s: TcoDiagnosticSource) => void }) {
  const infos = diagnostics.items.filter((d) => d.status === 'INFORMATIONAL');
  if (!infos.length) return null;
  return (
    <section className="space-y-1.5" aria-labelledby="tco-informations-titre" data-tco-diagnostics-info={infos.length}>
      <h3 id="tco-informations-titre" className="vb-app-subsection m-0">Bon à savoir</h3>
      <ul className="space-y-1.5">
        {infos.map((d) => {
          const premiere = d.sources.find((s) => s.lineId && s.visible);
          return (
            <li key={d.code} className="text-xs text-muted-foreground flex items-start gap-1.5" data-tco-diagnostic={d.code} data-tco-diagnostic-nature={d.nature}>
              <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="text-[color:var(--text-primary)]">{d.count != null && d.count > 1 ? `${d.count} · ` : ''}{d.title}</span> — {d.text}
                {premiere && (
                  <>
                    {' '}
                    <button type="button" onClick={() => onShowLine(premiere)} className="inline-flex min-h-[44px] md:min-h-0 items-center text-primary hover:underline" data-tco-diagnostic-show-line={premiere.lineId}>
                      {d.count != null && d.count > 1 ? 'Voir les dépenses' : 'Voir la dépense'}
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Lot 111V : « Vos choix confirmés » — groupe distinct des alertes et des exclusions normales (jamais une
 * anomalie) ; chaque choix reste visible et réversible (« Annuler mon choix »), même après recalcul ou T3.
 */
export function TcoDecidedDiagnostics({ diagnostics, onShowLine, decide }: { diagnostics: TcoDiagnostics; onShowLine: (s: TcoDiagnosticSource) => void; decide?: TcoDiagnosticsDecide }) {
  const choix = diagnostics.items.filter((d) => d.status === 'DECIDED');
  const sources = choix.flatMap((d) => d.sources);
  const [ouvert, setOuvert] = useState(false);
  if (!sources.length) return null;
  // Lot 113N : une même ligne peut porter deux choix distincts (arbitrage et « conservée sans date ») — un par choix.
  const vus = new Set<string>();
  const uniques = sources.filter((s) => { const k = `${s.lineId ?? s.label}|${s.decision?.value ?? ''}`; if (vus.has(k)) return false; vus.add(k); return true; });
  /** Annulation propre au choix montré (jamais l'annulation d'un autre choix de la même ligne). */
  const annulation = (s: TcoDiagnosticSource) => (s.actions ?? []).filter((o) => o.action === (s.decision?.value === 'CONFIRM_UNDATED' ? 'REVERT_UNDATED' : 'REVERT'));
  return (
    <section className="space-y-1.5" aria-labelledby="tco-choix-titre" data-tco-diagnostics-decided={uniques.length}>
      <h3 id="tco-choix-titre" className="vb-app-subsection m-0 flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden /> {`Vos choix confirmés (${uniques.length})`}
      </h3>
      <p className="text-xs text-muted-foreground">Le coût de possession applique vos choix ; ils restent modifiables à tout moment.</p>
      {!ouvert ? (
        <button type="button" onClick={() => setOuvert(true)} className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs text-primary hover:underline" aria-expanded={false} data-tco-diagnostics-decided-toggle>
          Afficher vos choix
        </button>
      ) : (
        <ul className="divide-y divide-border" aria-label="Vos choix confirmés">
          {uniques.map((s, i) => (
            <li key={`${s.lineId ?? s.label}:${i}`} className="py-1.5 min-w-0" data-tco-decided-line={s.lineId ?? ''} data-tco-decided-value={s.decision?.value ?? ''}>
              <div className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0 break-words text-[color:var(--text-primary)]">{s.label}</span>
                {s.amountCents != null && <span className="shrink-0 tabular-nums text-muted-foreground">{eur(s.amountCents)}</span>}
              </div>
              {s.detail && <p className="text-xs text-muted-foreground">{s.detail}</p>}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <TcoJustificatif fileId={s.fileId} />
                {s.lineId && s.visible && (
                  <button type="button" onClick={() => onShowLine(s)} className="inline-flex min-h-[44px] md:min-h-0 items-center gap-1 text-xs text-primary hover:underline">
                    <ChevronRight className="w-3 h-3 shrink-0" aria-hidden /> Voir la dépense
                  </button>
                )}
              </div>
              {decide && s.lineId && annulation(s).length > 0 && (
                <TcoDecisionActions lineId={s.lineId} lineKey={s.lineKey ?? null} lineVersion={s.lineVersion ?? null} options={annulation(s)} onDecide={decide.onDecide} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
