"use client";

/**
 * Vues du BO diagnostic des Opérations (lot 47A, O9 — CDC Opérations V1
 * ch. 21, B23, C26.1, C26.2) — composants PURS (props → rendu), testés par
 * rendu statique (`o9-bo-diagnostic-ui.test.ts`).
 *
 * LECTURE SEULE (INV-032, F-182, décision PO Q9) : aucun bouton d'édition,
 * de fusion, de suppression, aucun interrupteur. SEULE exception (lot 79A,
 * PO 22/10/2026) : « Rétablir » une séparation d'identité encore effective,
 * rendu par la page détail via `identityAction` (jamais par ces vues seules). Les seuls liens mènent à
 * d'autres écrans de consultation du BO (compte, exécutions IA d'un document,
 * File IA du compte pour relancer un travail T3 existant).
 *
 * Desktop ET mobile : mêmes composants ; tableaux défilants horizontalement
 * (`overflow-x-auto`) comme le reste du BO, grilles qui passent d'une à
 * plusieurs colonnes (`grid-cols-1 sm:… lg:…`), filtres empilés sur mobile.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatDate, formatDateTime, formatMoney } from '@/lib/admin/format';
import type {
  HoldItem, IndicatorResult, IndicatorsReport, OperationDetail, OperationListItem,
} from '@/services/business-operations/diagnostics/service';
import { m3ProgressLabel, type HardAnomalyResult } from '@/services/business-operations/diagnostics/model';
import {
  RESTORE_BLOCK_MESSAGES, canRestore, type RestoreBlockCode, type RestoreSummary, type RestoreTrace,
} from '@/services/business-operations/identity-restore.model';

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const yes = (v: unknown) => v === true;

export const READ_ONLY_NOTICE =
  'Lecture seule : le back-office explique une Opération, il ne la modifie jamais (ni type, ni statut, ni montant, ni fusion, ni source).';

/** Lien vers la File IA filtrée sur les travaux T3 du compte (relance d'un échec existante). */
export const t3QueueHref = (accountId: number) => `/admin/ai-queue?treatment=T3&accountId=${accountId}&status=`;
/** Exécutions IA d'un document (seul « lien vers le document » du BO : aucun nom, aucun téléchargement). */
export const documentHref = (accountId: number, fileId: number) =>
  `/admin/ai-executions?accountId=${accountId}&objectType=asset_file&objectId=${fileId}`;

export function ReadOnlyNotice() {
  return (
    <div className="flex items-start gap-2 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <p>{READ_ONLY_NOTICE}</p>
    </div>
  );
}

export function OperationStateBadge({ op }: { op: Pick<OperationListItem, 'invalidatedAt' | 'mergedIntoOperationId'> }) {
  if (op.mergedIntoOperationId) return <Badge variant="secondary">Fusionnée → #{op.mergedIntoOperationId}</Badge>;
  if (op.invalidatedAt) return <Badge variant="destructive">Invalidée</Badge>;
  return <Badge variant="outline">Active</Badge>;
}

const STATUS: Record<string, string> = { ENVISAGED: 'Envisagée', REALIZED: 'Réalisée', CANCELLED: 'Annulée' };

function money(cents: number | null, partial = false) {
  if (cents === null) return '—';
  return `${formatMoney(cents, 'EUR')}${partial ? ' (partiel)' : ''}`;
}

// ── Liste ───────────────────────────────────────────────────────────────────

export function OperationsTable({ items }: { items: OperationListItem[] }) {
  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="px-3 py-2 font-medium">ID</th>
            <th className="px-3 py-2 font-medium">Compte</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Statut</th>
            <th className="px-3 py-2 font-medium min-w-[12rem]">Libellé</th>
            <th className="px-3 py-2 font-medium">Bien(s) / équipement(s)</th>
            <th className="px-3 py-2 font-medium">Parent</th>
            <th className="px-3 py-2 font-medium">Date principale</th>
            <th className="px-3 py-2 font-medium text-right">Net indicatif</th>
            <th className="px-3 py-2 font-medium text-right">Sources</th>
            <th className="px-3 py-2 font-medium text-right">Composantes</th>
            <th className="px-3 py-2 font-medium">Dernière réconciliation</th>
            <th className="px-3 py-2 font-medium">État</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={13} className="px-3 py-6 text-center text-muted-foreground">Aucune Opération ne correspond à ces critères.</td></tr>
          )}
          {items.map((o) => (
            <tr key={o.id} className="border-b last:border-b-0 hover:bg-muted/40 align-top">
              <td className="px-3 py-2 whitespace-nowrap"><Link href={`/admin/operations/${o.id}`} className="font-medium hover:underline">#{o.id}</Link></td>
              <td className="px-3 py-2"><Link href={`/admin/accounts/${o.accountId}`} className="hover:underline">{o.accountName ?? `#${o.accountId}`}</Link></td>
              <td className="px-3 py-2 whitespace-nowrap">{o.typeLabel}</td>
              <td className="px-3 py-2 whitespace-nowrap">{STATUS[o.status] ?? o.status}</td>
              <td className="px-3 py-2"><Link href={`/admin/operations/${o.id}`} className="hover:underline">{o.label ?? '—'}</Link></td>
              <td className="px-3 py-2 text-xs">
                {o.assets.length === 0 && o.equipments.length === 0
                  ? <span className="text-[color:var(--text-warning-soft)]">sans bien</span>
                  : [...o.assets.map((a) => a.name ?? `bien #${a.id}`), ...o.equipments.map((e) => e.name ?? `équipement #${e.id}`)].join(', ')}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{o.parentOperationId ? <Link href={`/admin/operations/${o.parentOperationId}`} className="hover:underline">#{o.parentOperationId}</Link> : '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap">{formatDate(o.principalDate)}</td>
              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(o.netCents, o.netPartial)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${o.activeSourceCount === 0 && !o.invalidatedAt ? 'text-[color:var(--text-danger)] font-semibold' : ''}`}>
                {o.activeSourceCount}{o.sourceCount !== o.activeSourceCount ? ` / ${o.sourceCount}` : ''}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{o.componentCount}</td>
              <td className="px-3 py-2 whitespace-nowrap text-xs">{formatDateTime(o.lastReconciledAt)}</td>
              <td className="px-3 py-2"><OperationStateBadge op={o} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Candidats en attente ────────────────────────────────────────────────────

export function HoldsTable({ items }: { items: HoldItem[] }) {
  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="px-3 py-2 font-medium">Candidat</th>
            <th className="px-3 py-2 font-medium">Compte</th>
            <th className="px-3 py-2 font-medium">Document</th>
            <th className="px-3 py-2 font-medium min-w-[14rem]">Résumé T1</th>
            <th className="px-3 py-2 font-medium">Confiance</th>
            <th className="px-3 py-2 font-medium">Issue T3</th>
            <th className="px-3 py-2 font-medium min-w-[14rem]">Motif</th>
            <th className="px-3 py-2 font-medium">Opérations proposées</th>
            <th className="px-3 py-2 font-medium min-w-[14rem]">Rapprochement IA (M3)</th>
            <th className="px-3 py-2 font-medium">Dernier passage</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">Aucun candidat en attente.</td></tr>
          )}
          {items.map((c) => (
            <tr key={c.id} className="border-b last:border-b-0 align-top">
              <td className="px-3 py-2 whitespace-nowrap">#{c.id}</td>
              <td className="px-3 py-2"><Link href={`/admin/accounts/${c.accountId}`} className="hover:underline">{c.accountName ?? `#${c.accountId}`}</Link></td>
              <td className="px-3 py-2 whitespace-nowrap">
                <Link href={documentHref(c.accountId, c.fileId)} className="inline-flex items-center gap-1 hover:underline">document #{c.fileId}<ExternalLink className="h-3 w-3" /></Link>
              </td>
              <td className="px-3 py-2 text-xs">{c.summary || '—'}{c.typeHint ? <span className="text-muted-foreground"> · indice {c.typeHint}</span> : null}</td>
              <td className="px-3 py-2 whitespace-nowrap">{c.confidence}</td>
              <td className="px-3 py-2 whitespace-nowrap">{c.outcome === 'ARBITRATION_REQUIRED' ? 'Arbitrage (À traiter)' : 'En attente (HOLD)'}</td>
              <td className="px-3 py-2 text-xs">
                <span>{c.reasonLabel}</span>{c.reason ? <code className="ml-1 text-[10px] text-muted-foreground">{c.reason}</code> : null}
                {c.technicalError ? (
                  <span className="block text-muted-foreground" data-t3-technical-error>
                    {c.technicalError.attempts} tentative{c.technicalError.attempts > 1 ? 's' : ''}
                    {c.technicalError.exhausted ? ' — reprises automatiques épuisées (corriger la cause, puis relancer le passage complet du compte)' : c.technicalError.retryAt ? ` — reprise automatique après ${formatDateTime(c.technicalError.retryAt)}` : ''}
                    {c.technicalError.jobId ? ` · job #${c.technicalError.jobId}` : ''}
                    {c.technicalError.message ? ` · ${c.technicalError.message}` : ''}
                  </span>
                ) : null}
                {c.cardsPending ? <span className="block text-muted-foreground" data-t3-cards-pending>cartes « À traiter » en attente de resynchronisation (reprise automatique)</span> : null}
              </td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {c.proposedOperationIds.length
                  ? c.proposedOperationIds.map((id, i) => <span key={id}>{i ? ', ' : ''}<Link href={`/admin/operations/${id}`} className="hover:underline">#{id}</Link></span>)
                  : '—'}
              </td>
              <td className="px-3 py-2 text-xs" data-m3-progress>
                {c.m3 ? (
                  <>
                    <span>{m3ProgressLabel(c.m3)}</span>
                    {c.m3.retryAfter ? <span className="block text-muted-foreground">reprise après {formatDateTime(c.m3.retryAfter)}</span> : null}
                    {c.m3.lastAttemptAt ? <span className="block text-muted-foreground">dernière tentative {formatDateTime(c.m3.lastAttemptAt)}</span> : null}
                  </>
                ) : '—'}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-xs">{formatDateTime(c.processedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Indicateurs et anomalies dures ─────────────────────────────────────────

const p = (v: unknown) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`);

/** Valeur principale d'un indicateur (pure). */
export function indicatorHeadline(ind: IndicatorResult): string {
  const v = ind.value;
  switch (ind.key) {
    case 'createdPerDayBySourceKind': return `${n(v.total)} créée(s) · ${String(v.averagePerDay ?? 0).replace('.', ',')} / jour`;
    case 'documentsWithCertainCandidate': return `${p(v.pct)} (${n(v.withCertain)} / ${n(v.analysed)})`;
    case 'certainCandidatesOutcome': return `CREATE ${p(v.createPct)} · MATCH ${p(v.matchPct)} (${n(v.total)})`;
    case 'typeNull': case 'typeOther': return `${p(v.pct)} (${n(v.count)} / ${n(v.active)})`;
    case 'mergedWithin7Days': case 'invalidatedWithin7Days': return `${n(v.count)} · ${p(v.pct)} des ${n(v.created)} créées`;
    case 'withoutTargetByAge': return `${n(v.h24)} / ${n(v.d7)} / ${n(v.d30)} / ${n(v.older)}`;
    case 'ambiguousSources': return `${n(v.total)} en attente · ${n(v.openCardsTotal)} carte(s) À traiter`;
    case 'componentsWithoutActiveSource': case 'activeWithoutActiveSource': return String(n(v.count));
    case 'crossAccountOrParentCycles': return `${n(v.crossAccount)} lien(s) · ${n(v.parentCycles)} cycle(s)`;
    case 't2EconomicAnswers': return `${p(v.operationOnlyPct)} / ${p(v.mixedPct)} / ${p(v.fallbackOnlyPct)} (${n(v.total)})`;
    default: return '—';
  }
}

function IndicatorDetail({ ind }: { ind: IndicatorResult }) {
  const v = ind.value;
  if (ind.key === 'createdPerDayBySourceKind') {
    const kinds = Object.entries((v.bySourceKind ?? {}) as Record<string, number>);
    const max = v.maxDay as { day: string; total: number } | null;
    return (
      <div className="text-xs text-muted-foreground space-y-1">
        <p>{kinds.length ? kinds.map(([k, c]) => `${k} ${c}`).join(' · ') : 'Aucune création sur la période.'}</p>
        {max && <p>Jour le plus haut : {formatDate(max.day)} ({max.total})</p>}
      </div>
    );
  }
  if (ind.key === 'ambiguousSources') {
    const reasons = (v.byReason ?? []) as Array<{ outcome: string; reason: string | null; label: string; count: number }>;
    return reasons.length ? (
      <ul className="text-xs text-muted-foreground space-y-0.5">
        {reasons.slice(0, 6).map((r) => <li key={`${r.outcome}:${r.reason}`}>{r.count} · {r.label}</li>)}
      </ul>
    ) : null;
  }
  if (ind.key === 'typeNull') {
    const by = Object.entries((v.byType ?? {}) as Record<string, number>);
    return by.length ? <p className="text-xs text-muted-foreground">{by.map(([k, c]) => `${k === 'NULL' ? 'non qualifié' : k} ${c}`).join(' · ')}</p> : null;
  }
  if (ind.key === 'withoutTargetByAge') return <p className="text-xs text-muted-foreground">0-24 h / 1-7 j / 8-30 j / plus de 30 j — aucune invalidation par âge</p>;
  if (ind.key === 't2EconomicAnswers') return <p className="text-xs text-muted-foreground">Opérations seules / mixtes / repli seul</p>;
  return null;
}

export function IndicatorCards({ indicators }: { indicators: IndicatorResult[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {indicators.map((ind) => {
        const alerte = ind.hard && Number(ind.value.count ?? 0) > 0;
        return (
          <div key={ind.key} data-indicator={ind.key} className={`rounded-xl border bg-card p-4 space-y-2 ${alerte ? 'border-[color:var(--border-danger)]' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{ind.label}</p>
              <Badge variant={ind.hard ? (alerte ? 'destructive' : 'outline') : 'secondary'}>
                {ind.hard ? 'Anomalie dure' : ind.scope === 'period' ? 'Période' : 'État actuel'}
              </Badge>
            </div>
            <p className={`text-xl font-bold tabular-nums ${alerte ? 'text-[color:var(--text-danger)]' : ''}`}>{indicatorHeadline(ind)}</p>
            <IndicatorDetail ind={ind} />
            <p className="text-xs text-muted-foreground italic">{ind.reading}</p>
          </div>
        );
      })}
    </div>
  );
}

export function HardAnomalyAlerts({ anomalies, procedure, accountId }: { anomalies: HardAnomalyResult[]; procedure: string; accountId: number | null }) {
  const actives = anomalies.filter((a) => a.count > 0);
  if (actives.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-4 text-sm">
        <p className="font-medium">Anomalies dures : 0</p>
        <p className="text-xs text-muted-foreground mt-1">{anomalies.map((a) => a.label).join(' · ')}</p>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-xl border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-5 w-5 text-[color:var(--text-danger)] shrink-0" />
        <div>
          <p className="font-semibold text-[color:var(--text-danger)]">Anomalies dures détectées ({actives.reduce((t, a) => t + a.count, 0)})</p>
          <p className="text-xs text-muted-foreground mt-1">{procedure}</p>
        </div>
      </div>
      {actives.map((a) => {
        const comptes = accountId ? [accountId] : a.accountIds;
        return (
          <div key={a.code} data-anomaly={a.code} className="rounded-lg border bg-card p-3 space-y-2">
            <p className="text-sm font-medium">{a.label} : <span className="tabular-nums">{a.count}</span> <code className="text-[10px] text-muted-foreground">{a.code}</code></p>
            <ul className="text-xs space-y-0.5">
              {a.samples.map((x, i) => (
                <li key={i}>
                  <Link href={`/admin/accounts/${x.accountId}`} className="hover:underline">compte #{x.accountId}</Link>
                  {x.operationId ? <> · <Link href={`/admin/operations/${x.operationId}`} className="hover:underline">Opération #{x.operationId}</Link></> : null}
                  {' '}— {x.detail}
                </li>
              ))}
            </ul>
            {comptes.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {comptes.slice(0, 5).map((c) => (
                  <span key={c} className="inline-flex flex-wrap gap-x-3">
                    <Link href={`/admin/operations?accountId=${c}`} className="underline">Opérations du compte #{c}</Link>
                    <Link href={t3QueueHref(c)} className="underline">Travaux T3 du compte #{c} (File IA)</Link>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function IndicatorsView({ report }: { report: IndicatorsReport }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Période du {formatDate(report.period.from)} au {formatDate(report.period.to)} ({report.period.days} j) ·
        {report.accountId ? ` compte #${report.accountId}` : ' tous les comptes'} · calculé le {formatDateTime(report.computedAt)}.
        Indicateurs observatoires : aucune valeur ne désactive le système.
      </p>
      <HardAnomalyAlerts anomalies={report.anomalies} procedure={report.procedure} accountId={report.accountId} />
      <IndicatorCards indicators={report.indicators} />
    </div>
  );
}

// ── Détail ──────────────────────────────────────────────────────────────────

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
        <h2 className="vb-app-section">{title}</h2>
        {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
      </div>
      <div className="p-4 text-sm">{children}</div>
    </section>
  );
}

function Grid({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ cols, rows, empty }: { cols: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground border-b">{cols.map((c) => <th key={c} className="px-2 py-1.5 font-medium whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b last:border-b-0 align-top">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const Active = ({ v }: { v: unknown }) => (yes(v) ? <span className="text-[color:var(--text-success)]">active</span> : <span className="text-muted-foreground">inactive</span>);
const json = (v: unknown) => (v === null || v === undefined ? '—' : <code className="text-[10px] break-all">{JSON.stringify(v)}</code>);
const opLinkPage = (id: unknown) => (id === null || id === undefined ? '—' : <Link href={`/admin/operations/${String(id)}`} className="hover:underline">#{String(id)}</Link>);
const amount = (minor: unknown, cur: unknown) => (minor === null || minor === undefined ? '—' : formatMoney(n(minor), String(cur ?? 'EUR')));

/** Lot 75N : navigation DANS le tiroir « Données du compte » (au lieu d'un changement d'écran). */
export type OperationDetailNavigate = (type: 'operation' | 'document' | 'asset' | 'equipment' | 'agenda', id: number) => void;

/** Lot 78A : libellés du contrôle d'identité économique et de la provenance (BO, lecture seule). */
const IDENTITY_KIND: Record<string, string> = {
  SEPARATED: 'Séparation (contradiction certaine)', SUSPECT: 'Rattachement douteux (conservé)', DUPLICATE_RELOCATED: 'Doublon d’un même document',
};
const IDENTITY_STATUS: Record<string, string> = { APPLIED: 'appliqué', OPEN: 'à examiner', RESOLVED: 'résolu', REVERTED: 'rétabli' };
const PROVENANCE_FIELDS: Array<[string, string]> = [
  ['plannedDate', 'Date prévue'], ['startDate', 'Date de début'], ['realizedDate', 'Date de réalisation'], ['endDate', 'Date de fin'],
  ['provider', 'Prestataire'], ['label', 'Libellé'],
];
function evidenceLabel(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const x = e as { candidateId?: unknown; hintIndexes?: unknown; factIds?: unknown };
  const faits = Array.isArray(x.factIds) ? x.factIds : [];
  const indices = Array.isArray(x.hintIndexes) ? x.hintIndexes : [];
  return ` ← candidat T1 #${String(x.candidateId ?? '?')}${indices.length ? `, indice ${indices.join('/')}` : ''}${faits.length ? `, fait #${faits.join('/#')}` : ''}`;
}

/**
 * Lot 79A : trace d'un rétablissement BO (« Rétablie par … le … — motif : … »).
 * Texte seul : affiché partout où le détail est rendu (page, tiroir 75N).
 */
export function restoredByLabel(t: RestoreTrace): string {
  const qui = t.adminEmail ?? (t.adminId !== null ? `administrateur #${t.adminId}` : 'un administrateur');
  return `Rétablie par ${qui} le ${formatDateTime(t.at)}${t.reason ? ` — motif : ${t.reason}` : ''}`;
}

/**
 * Lot 79A : `identityAction` rend l'action « Rétablir » d'une séparation encore
 * effective (`canRestore`) — fournie par la SEULE page détail d'Opération
 * (exception PO à Q9). Sans elle (tests, tiroir « Données du compte »), la
 * vue reste strictement en lecture seule.
 */
export function OperationDetailView({ d, onNavigate, identityAction }: {
  d: OperationDetail; onNavigate?: OperationDetailNavigate; identityAction?: (restore: RestoreSummary) => ReactNode;
}) {
  const o = d.operation;
  const acc = o.accountId;
  const navButton = (type: Parameters<OperationDetailNavigate>[0], id: number, label: ReactNode) => (
    <button type="button" className="underline-offset-2 hover:underline text-left" onClick={() => onNavigate!(type, id)}>{label}</button>
  );
  // Sans `onNavigate` : liens d'écran historiques (page détail d'Opération).
  const opLink = (id: unknown) => (id === null || id === undefined ? '—' : onNavigate ? navButton('operation', Number(id), `#${String(id)}`) : opLinkPage(id));
  const docLink = (fileId: number, label: ReactNode, cls: string) => (onNavigate
    ? <button type="button" className={`${cls} text-left`} onClick={() => onNavigate('document', fileId)}>{label}</button>
    : <Link href={documentHref(acc, fileId)} className={cls}>{label}</Link>);
  const named = (type: 'asset' | 'equipment', id: unknown, label: string) => (onNavigate && id != null ? navButton(type, Number(id), label) : label);
  return (
    <div className="space-y-4">
      <ReadOnlyNotice />
      {d.canonicalOperationId && d.canonicalOperationId !== o.id && (
        <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-3 text-sm">
          Opération fusionnée : l’Opération canonique est {opLink(d.canonicalOperationId)}.
        </div>
      )}
      <Section title="Identité">
        <Grid items={[
          ['Compte', <Link key="a" href={`/admin/accounts/${acc}`} className="hover:underline">{o.accountName ?? `#${acc}`}</Link>],
          ['Type', o.typeLabel],
          ['Statut', STATUS[o.status] ?? o.status],
          ['État', <OperationStateBadge key="e" op={o} />],
          ['Libellé technique', s(o.label)],
          ['Prestataire', s(o.provider)],
          ['Date prévue', formatDate(o.plannedDate)],
          ['Date de début', formatDate(o.startDate)],
          ['Date de réalisation', formatDate(o.realizedDate)],
          ['Date de fin', formatDate(o.endDate)],
          ['Clôture', formatDateTime(o.closedAt)],
          ['Invalidation', o.invalidatedAt ? `${formatDateTime(o.invalidatedAt)} — ${s(o.invalidationReason)}` : '—'],
          ['Net indicatif', money(o.netCents, o.netPartial)],
          ['Créée le', formatDateTime(o.createdAt)],
          ['Dernière réconciliation', formatDateTime(o.lastReconciledAt)],
          ['État de réconciliation', <span key="r" className={d.reconciliation.state === 'A_JOUR' ? '' : 'text-[color:var(--text-warning-soft)]'}>{d.reconciliation.label}</span>],
          ['Version', String(o.version)],
        ]} />
      </Section>

      <Section title="Biens et équipements" count={d.assetLinks.length + d.equipmentLinks.length}>
        <Table cols={['Bien', 'Rôle', 'Autorité', 'Source', 'Lien']} empty="Aucun bien lié (cible non résolue)."
          rows={d.assetLinks.map((l: Row) => [named('asset', l.asset_id, `${s(l.asset_name)} (#${s(l.asset_id)})${yes(l.asset_deleted) ? ' — supprimé' : ''}`), s(l.link_role), s(l.authority), s(l.source_id), <Active key="a" v={l.active} />])} />
        {d.equipmentLinks.length > 0 && (
          <div className="mt-3">
            <Table cols={['Équipement', 'Bien', 'Autorité', 'Source', 'Lien']} empty=""
              rows={d.equipmentLinks.map((l: Row) => [named('equipment', l.equipment_id, `${s(l.equipment_name)} (#${s(l.equipment_id)})`), named('asset', l.asset_id, `#${s(l.asset_id)}`), s(l.authority), s(l.source_id), <Active key="a" v={l.active} />])} />
          </div>
        )}
      </Section>

      <Section title="Sources (actives et historiques)" count={d.sources.length}>
        <Table cols={['#', 'Nature', 'Objet', 'Rôle', 'Autorité', 'Confiance', 'Rapprochement', 'Localisation', 'État']} empty="Aucune source."
          rows={d.sources.map((x: Row) => [
            s(x.id),
            s(x.source_kind),
            x.file_id
              ? <span key="d">{docLink(n(x.file_id), <>document #{s(x.file_id)}<ExternalLink className="h-3 w-3" /></>, 'inline-flex items-center gap-1 hover:underline whitespace-nowrap')}</span>
              : `${s(x.source_entity_key)}${x.source_version ? ` v${s(x.source_version)}` : ''}`,
            s(x.source_role),
            s(x.authority),
            s(x.confidence),
            <span key="m">{x.match_method ? `${s(x.match_method)} — ` : ''}{s(x.match_reason_label)}</span>,
            json(x.locator),
            yes(x.active) ? <Active key="e" v /> : <span key="e" className="text-muted-foreground">supersédée {formatDateTime(x.superseded_at as string)}</span>,
          ])} />
      </Section>

      <Section title="Composantes financières" count={d.components.length}>
        <Table cols={['#', 'Nature', 'Montant', 'EUR', 'Date', 'Cible', 'Sources', 'État']} empty="Aucune composante."
          rows={d.components.map((c: Row) => [
            s(c.id), s(c.kind), amount(c.amount_minor, c.currency), c.amount_eur_cents == null ? '—' : formatMoney(n(c.amount_eur_cents), 'EUR'),
            formatDate((c.economic_date ?? c.period_start) as string | null),
            c.target_asset_id ? `bien #${s(c.target_asset_id)}` : c.target_equipment_id ? `équipement #${s(c.target_equipment_id)}` : 'non allouée',
            ((c.sources ?? []) as Row[]).map((x) => `#${s(x.sourceId)} ${s(x.evidenceRole)}${yes(x.isPrimary) ? ' (principale)' : ''}${yes(x.sourceActive) ? '' : ' — inactive'}${evidenceLabel(x.evidence)}`).join(', ') || <span key="z" className="text-[color:var(--text-danger)]">aucune</span>,
            <Active key="e" v={c.active} />,
          ])} />
      </Section>

      {(d.attributeProvenance || (d.identityReviews?.length ?? 0) > 0) && (
        <Section title="Identité économique et provenance (lot 78A)" count={d.identityReviews?.length ?? 0}>
          <Grid items={PROVENANCE_FIELDS.map(([k, label]): [string, ReactNode] => {
            const f = ((d.attributeProvenance?.fields ?? {}) as Record<string, Row | undefined>)[k];
            return [label, f ? `${s(f.value)} — source #${s(f.sourceId)}` : '—'];
          })} />
          {((d.attributeProvenance?.arbitratedConflicts ?? []) as Row[]).length > 0 && (
            <div className="mt-3">
              <Table cols={['Attribut arbitré au BO (rétablissement)', 'Valeurs (sources)', 'Conservée']} empty=""
                rows={((d.attributeProvenance?.arbitratedConflicts ?? []) as Row[]).map((c) => [
                  s(c.field), ((c.values ?? []) as Row[]).map((v) => `${s(v.value)} (#${((v.sourceIds ?? []) as unknown[]).join(', #')})`).join(' ; '), s(c.retained),
                ])} />
            </div>
          )}
          {((d.attributeProvenance?.conflicts ?? []) as Row[]).length > 0 && (
            <div className="mt-3">
              <Table cols={['Attribut contradictoire', 'Valeurs (sources)', 'Conservée']} empty=""
                rows={((d.attributeProvenance?.conflicts ?? []) as Row[]).map((c) => [
                  s(c.field), ((c.values ?? []) as Row[]).map((v) => `${s(v.value)} (#${((v.sourceIds ?? []) as unknown[]).join(', #')})`).join(' ; '), s(c.retained),
                ])} />
            </div>
          )}
          {(d.identityReviews?.length ?? 0) > 0 && (
            <div className="mt-3">
              <Table cols={['Contrôle', 'État', 'Document', 'Source', 'Opération d’origine', 'Opération retenue', 'Signaux', 'Date', 'Rétablissement']} empty=""
                rows={(d.identityReviews ?? []).map((r: Row) => [
                  IDENTITY_KIND[s(r.kind)] ?? s(r.kind), IDENTITY_STATUS[s(r.status)] ?? s(r.status),
                  r.file_id ? <span key="d">{docLink(n(r.file_id), `document #${s(r.file_id)} (${s(r.candidate_key)})`, 'hover:underline whitespace-nowrap')}</span> : '—',
                  s(r.source_id), opLink(r.operation_id), opLink(r.target_operation_id),
                  ((r.signals ?? []) as unknown[]).map(String).join(' '), formatDateTime(r.created_at as string),
                  r.restoredBy
                    ? <span key="t" className="text-xs" data-identity-restored={s(r.id)}>{restoredByLabel(r.restoredBy as RestoreTrace)}</span>
                    : canRestore(r) && identityAction ? <span key="b">{identityAction(r.restore)}</span>
                      : r.kind === 'SEPARATED' && r.restore_block ? <span key="x" className="text-xs text-muted-foreground">{RESTORE_BLOCK_MESSAGES[r.restore_block as RestoreBlockCode] ?? '—'}</span> : '—',
                ])} />
            </div>
          )}
        </Section>
      )}

      <Section title="Références" count={d.references.length}>
        <Table cols={['Nature', 'Valeur', 'Normalisée', 'Source', 'État']} empty="Aucune référence."
          rows={d.references.map((r: Row) => [s(r.reference_kind), s(r.reference_value), s(r.normalized_value), s(r.source_id), <Active key="e" v={r.active} />])} />
      </Section>

      {(d.contractDetails || d.financingDetails || d.claimDetails) && (
        <Section title="Détails par type">
          {d.contractDetails && <Grid items={[['Référence du contrat', s(d.contractDetails.contract_reference)], ['Périodicité', s(d.contractDetails.periodicity)], ['Effet', `${formatDate(d.contractDetails.effective_from as string)} → ${formatDate(d.contractDetails.effective_to as string)}`]]} />}
          {d.financingDetails && <Grid items={[['Référence du financement', s(d.financingDetails.financing_reference)], ['Prêteur', s(d.financingDetails.lender)], ['Capital', amount(d.financingDetails.principal_amount_minor, d.financingDetails.principal_currency)], ['Effet', `${formatDate(d.financingDetails.effective_from as string)} → ${formatDate(d.financingDetails.effective_to as string)}`]]} />}
          {d.claimDetails && <Grid items={[['Nature du sinistre', s(d.claimDetails.claim_type)], ['Déclaré le', formatDate(d.claimDetails.declared_on as string)], ['Réf. assureur', s(d.claimDetails.insurer_claim_ref)], ['Contrat d’assurance', opLink(d.claimDetails.insurance_contract_operation_id)], ['Avancement', s(d.claimDetails.status)], ['Dommage estimé', amount(d.claimDetails.estimated_damage_minor, 'EUR')], ['Dommages / actions / échanges', `${n(d.claimDetails.damages)} / ${n(d.claimDetails.actions)} / ${n(d.claimDetails.exchanges)}`]]} />}
        </Section>
      )}

      <Section title="Parent, enfants et fusion">
        <Grid items={[
          ['Parent', d.parent ? <span key="p">{opLink(d.parent.id)} {s(d.parent.type_code)} — {s(d.parent.technical_label)}</span> : '—'],
          ['Enfants', d.children.length ? <span key="c">{d.children.map((c, i) => <span key={String(c.id)}>{i ? ', ' : ''}{opLink(c.id)} {s(c.type_code)}</span>)}</span> : '—'],
          ['Fusionnée dans', opLink(o.mergedIntoOperationId)],
          ['A absorbé', d.mergedFrom.length ? <span key="m">{d.mergedFrom.map((c, i) => <span key={String(c.id)}>{i ? ', ' : ''}{opLink(c.id)}</span>)}</span> : '—'],
        ]} />
      </Section>

      <Section title="Décisions de rapprochement (REJECTED / CONFIRMED)" count={d.matchDecisions.length}>
        <Table cols={['Décision', 'Origine', 'Motif', 'Source', 'Date', 'État']} empty="Aucune décision."
          rows={d.matchDecisions.map((m: Row) => [s(m.decision), s(m.origin), s(m.reason_code_label), `${s(m.source_kind)} ${s(m.source_entity_key)}`, formatDateTime(m.created_at as string), <Active key="e" v={m.active} />])} />
      </Section>

      <Section title="Candidats T1 liés et issue T3" count={d.candidates.length}>
        <Table cols={['#', 'Document', 'Résumé', 'Confiance', 'Indice de type', 'Issue T3', 'Motif', 'Exécution IA', 'Opération', 'État']} empty="Aucun candidat T1."
          rows={d.candidates.map((c: Row) => [
            s(c.id),
            <span key="d">{docLink(n(c.file_id), `document #${s(c.file_id)}`, 'hover:underline whitespace-nowrap')}</span>,
            s(c.summary), `${s(c.confidence)}${yes(c.established) ? '' : ' (non établi)'}`, s(c.type_hint),
            yes(c.t3_pending) ? 'en file T3' : s(c.t3_outcome),
            s(c.t3_reason_label), s(c.ai_label), opLink(c.t3_operation_id), s(c.status),
          ])} />
      </Section>

      <Section title="Agenda (projection et suppressions)" count={d.agendaItems.length + d.projectionSuppressions.length}>
        <Table cols={['Événement', 'Date', 'Origine', 'Corrélation']} empty="Aucun événement d’agenda lié."
          rows={d.agendaItems.map((a: Row) => [onNavigate ? navButton('agenda', n(a.id), `#${s(a.id)} ${s(a.title)}`) : `#${s(a.id)} ${s(a.title)}`, formatDate(a.start_date as string), a.projection_origin === 'OPERATION' ? 'projeté (T4)' : 'rapproché', s(a.projection_correlation_id)])} />
        {d.projectionSuppressions.length > 0 && (
          <div className="mt-3">
            <Table cols={['Suppression durable', 'Clé', 'Utilisateur', 'Date']} empty=""
              rows={d.projectionSuppressions.map((x: Row) => [s(x.projection_kind), s(x.projection_key), s(x.user_id), formatDateTime(x.created_at as string)])} />
          </div>
        )}
      </Section>

      <Section title="Historique" count={d.history.length}>
        <Table cols={['Date', 'Événement', 'Motif', 'Source', 'Avant', 'Après', 'Corrélation']} empty="Aucun historique."
          rows={d.history.map((h: Row) => [formatDateTime(h.created_at as string), s(h.event_type), <span key="r">{s(h.reason_code_label)} <code className="text-[10px] text-muted-foreground">{s(h.reason_code)}</code></span>, s(h.source_id), json(h.before_json), json(h.after_json), s(h.correlation_id)])} />
      </Section>

      <Section title="Dernier passage T3 du compte">
        {d.lastT3Pass ? (
          <Grid items={[
            ['Travail', `#${d.lastT3Pass.jobId} — ${d.lastT3Pass.status}${d.lastT3Pass.businessResult ? ` (${d.lastT3Pass.businessResult})` : ''}`],
            ['Déclencheur', s(d.lastT3Pass.triggerCode)],
            ['Terminé le', formatDateTime(d.lastT3Pass.finishedAt)],
            ['Tentatives', String(d.lastT3Pass.attempts)],
            ['correlation_id', s(d.lastT3Pass.correlationId)],
            ['Dernière erreur', s(d.lastT3Pass.lastError)],
          ]} />
        ) : <p className="text-xs text-muted-foreground">Aucun travail T3 Opérations pour ce compte.</p>}
        {d.operationMatchBranch && (
          <p className={`text-xs mt-3 ${d.operationMatchBranch.available ? 'text-muted-foreground' : 'text-[color:var(--text-warning-soft)]'}`}>
            Rapprochement IA (OPERATION_MATCH) : {d.operationMatchBranch.available
              ? `disponible dans la configuration active${d.operationMatchBranch.version ? ` (${d.operationMatchBranch.version})` : ''}`
              : 'ABSENT de la configuration active — BO › Configuration IA › Prompts maîtres › T3 : « Repartir du texte livré avec l’application » puis « Activer »'}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-3">{d.procedure}</p>
        <Link href={t3QueueHref(acc)} className="mt-2 inline-flex items-center gap-1 text-xs underline">Travaux T3 du compte (File IA)</Link>
      </Section>
    </div>
  );
}
