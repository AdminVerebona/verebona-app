"use client";

/**
 * BO › Opérations › « Coût de possession » (lot 61, ticket P1 TCO §6) —
 * diagnostic LECTURE SEULE du TCO d'un bien : chaque ligne examinée
 * (composante consolidée, justificatif, prix de la fiche), retenue ou
 * écartée, avec son motif. Permet d'expliquer chaque euro sans accès SQL ni
 * création d'Opération. Desktop : tableau ; mobile : cartes empilées.
 */
import Link from 'next/link';
import type { TcoEconomicLine, TcoResult } from '@/services/business-operations/tco/model';
import { ACQUISITION_CANDIDATE_REASON_LABELS, ACQUISITION_START_BASIS_LABELS } from '@/services/business-operations/tco/acquisition-start';
import { TcoUsageDiagnostic } from './TcoUsageDiagnostic';
import type { TcoDiagnostics } from '@/services/business-operations/tco/diagnostics';

export interface TcoDiagnosticResponse {
  accountId: number;
  assetId: number;
  tco: Omit<TcoResult, 'entries'>;
  componentsExamined: number;
  /** Lot 68 : lignes non montrées sur la fiche du bien (motif). Absent : réponse antérieure. */
  userView?: { hidden: Record<string, string> };
  labels: { status: Record<string, string>; reason: Record<string, string>; warning: Record<string, string>; hidden?: Record<string, string> };
  /** Lot 109C : diagnostics structurés (mêmes que la fiche). Absent : réponse antérieure. */
  diagnostics?: TcoDiagnostics;
}

const NATURE_BO: Record<string, string> = { ANOMALY: 'Anomalie', COVERAGE: 'Couverture', INFORMATION: 'Information' };
/** Lot 111V : statut d'un diagnostic en français (jamais le code brut ; code inconnu : affiché tel quel). */
export const STATUT_DIAGNOSTIC_BO: Readonly<Record<string, string>> = {
  OPEN: 'Ouvert', IN_PROGRESS: 'Contrôle en attente', INFORMATIONAL: 'Information', DECIDED: 'Choix confirmé par l’utilisateur',
};

/** Lot 109C : code stable, nature, statut, nombre réel d'occurrences et sources (identifiants) de chaque diagnostic. */
function DiagnosticsBo({ d }: { d: TcoDiagnostics }) {
  if (!d.items.length) return <p className="text-xs text-muted-foreground" data-bo-tco-diagnostics="0">Aucun diagnostic (aucune anomalie détectée — ne signifie pas que toutes les dépenses possibles sont connues).</p>;
  return (
    <div className="rounded-lg border p-3 text-xs space-y-1.5" data-bo-tco-diagnostics={d.items.length}>
      <p className="font-medium text-sm">Diagnostics ({d.open.families} ouvert(s), {d.inProgress} en cours, {d.information} information(s){d.decided ? `, ${d.decided} choix confirmé(s)` : ''})</p>
      <ul className="space-y-1">
        {d.items.map((x) => (
          <li key={x.code} className="break-words" data-bo-tco-diagnostic={x.code} data-bo-tco-diagnostic-nature={x.nature}>
            <span className="font-mono">{x.code}</span> · {NATURE_BO[x.nature]} · <span data-bo-tco-diagnostic-status={x.status}>{STATUT_DIAGNOSTIC_BO[x.status] ?? x.status}</span> · {x.count ?? 'nombre inconnu'} occurrence(s){x.traced ? '' : ' · sources non retrouvées'}
            {x.amountCents != null ? ` · ${eur(x.amountCents)}` : ''}
            {x.sources.length > 0 && (
              <span className="block text-muted-foreground">
                {x.sources.map((s) => [s.lineId, s.fileId != null ? `fichier #${s.fileId}` : null, s.operationId != null ? `opération #${s.operationId}` : null, s.assetField].filter(Boolean).join(' / ')).join(' ; ')}
                {x.sourcesTruncated ? ' ; …' : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lot 68 : mention « masquée sur la fiche » d'une ligne (toutes les lignes restent listées ici). */
function Masquee({ id, data }: { id: string; data: TcoDiagnosticResponse }) {
  const m = data.userView?.hidden[id];
  if (!m) return null;
  return <p className="text-xs text-muted-foreground italic" data-bo-tco-hidden={m}>{data.labels.hidden?.[m] ?? m}</p>;
}

const eur = (c: number | null | undefined) => (c == null ? '—' : (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));
const minor = (m: number, cur: string) => `${(m / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const RETENUE = new Set(['RETAINED_DIRECT', 'RETAINED_CONSOLIDATED']);
const SOURCE: Record<string, string> = { OPERATION: 'Composante', DOCUMENT: 'Justificatif', ASSET_DATA: 'Fiche', EQUIPMENT_DATA: 'Fiche équipement' };
/** Lot 75D (D) : montant inconnu — jamais « 0,00 » ; rapprochement incertain signalé. */
const montant = (l: TcoEconomicLine) => (l.amountUnknown ? 'montant inconnu' : minor(l.amountMinor, l.currency));
function Incertaine({ l }: { l: TcoEconomicLine }) {
  return l.uncertain ? <p className="text-xs text-[color:var(--text-warning-soft)]" data-bo-tco-uncertain>Rapprochement incertain (compté, à vérifier)</p> : null;
}

function Badge({ l, labels }: { l: TcoEconomicLine; labels: TcoDiagnosticResponse['labels'] }) {
  const ok = RETENUE.has(l.status);
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${ok ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]' : 'bg-muted text-muted-foreground'}`}>
      {labels.status[l.status] ?? l.status}
    </span>
  );
}

const STATUT_DEPART: Record<string, string> = {
  RESOLVED: 'Date retenue', MISSING: 'Date inconnue', UNDETERMINED: 'Indéterminée (contradiction sans autorité)', REJECTED: 'Date de la fiche impossible',
};
const CONTRADICTION: Record<string, string> = {
  OPERATION_VS_USER_DATE: 'Achat daté autrement que la date saisie sur la fiche',
  OPERATION_VS_AUTOMATIC_DATE: 'Achat daté autrement que la date automatique de la fiche',
  OPERATIONS_DISAGREE: 'Plusieurs achats possibles aux dates différentes',
};
const ORIGINE_LUE: Record<string, string> = { key: 'clé canonique', alias: 'alias historique', column: 'colonne historique' };
const jj = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');

/**
 * Lot 107C — diagnostic de la date de DÉPART du TCO : date retenue, source et
 * origine, candidats (fiche, Opérations ACQUISITION) retenus ou rejetés avec
 * leur motif, contradictions, réparation proposée, date que l'ancienne règle
 * aurait retenue (avant / après). Desktop et mobile : liste empilée.
 */
function DepartDiagnostic({ t, accountId }: { t: TcoDiagnosticResponse['tco']; accountId: number }) {
  const r = t.acquisitionStart;
  if (!r) return null;
  const c = r.canonical;
  return (
    <div className="rounded-lg border p-3 text-xs space-y-2" data-bo-tco-start={r.status}>
      <p className="font-medium text-sm">Date de départ du TCO annuel</p>
      <p>
        <span className="font-medium">{STATUT_DEPART[r.status] ?? r.status}</span>
        {r.date ? <> : {jj(r.date)}</> : null}
        {r.basis ? <> · {ACQUISITION_START_BASIS_LABELS[r.basis]}</> : null}
        {r.operationId ? <> · <Link className="underline" href={`/admin/operations/${r.operationId}?accountId=${accountId}`}>Opération #{r.operationId}</Link></> : null}
        {` · ${r.kind === 'POSSESSION' ? 'début de possession (aucun achat)' : 'achat du bien'}`}
      </p>
      {c && (
        <p className="text-muted-foreground break-words" data-bo-tco-start-canonical>
          Fiche : « {c.raw} » · origine {c.origin}{c.human ? ' (saisie humaine, prioritaire)' : ' (automatique)'} · lue depuis {ORIGINE_LUE[c.from ?? 'key'] ?? c.from}{c.fromName ? ` (${c.fromName})` : ''}
          {c.lastWrite ? ` · dernière écriture : ${c.lastWrite.value ?? '—'} (${c.lastWrite.origin}, ${c.lastWrite.sourceType ?? 'source inconnue'}${c.lastWrite.sourceId ? ` #${c.lastWrite.sourceId}` : ''}, ${c.lastWrite.at.slice(0, 16)})` : ' · aucune écriture journalisée (valeur historique)'}
        </p>
      )}
      {r.legacyDate !== r.date && (
        <p className="text-[color:var(--text-warning-soft)]" data-bo-tco-start-legacy>Ancienne règle (plus ancienne acquisition) : {jj(r.legacyDate)} — date retenue désormais : {jj(r.date)}.</p>
      )}
      {r.contradictions.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5 text-[color:var(--text-warning-soft)]" data-bo-tco-start-contradictions>
          {r.contradictions.map((x, i) => (
            <li key={i} className="break-words">{CONTRADICTION[x.code] ?? x.code} : {x.dates.map(jj).join(' / ')}{x.operationIds.length ? ` (Opération(s) #${x.operationIds.join(', #')})` : ''} — {x.resolvedBy === 'USER_AUTHORITY' ? 'tranchée par la saisie de l’utilisateur' : x.resolvedBy === 'PROOF' ? 'tranchée par la preuve de l’achat' : 'non tranchée'}</li>
          ))}
        </ul>
      )}
      {r.repair && (
        <p data-bo-tco-start-repair>Réparation proposée (contrôle COH-OPS-ACQUISITION-DATE) : {r.repair.kind === 'ENRICH_CANONICAL' ? 'renseigner' : 'corriger la valeur automatique de'} la date d’achat de la fiche avec {jj(r.repair.value)} (Opération #{r.repair.operationId}).</p>
      )}
      {r.candidates.length > 0 && (
        <ul className="space-y-1" data-bo-tco-start-candidates>
          {r.candidates.map((x, i) => (
            <li key={`${x.kind}:${x.operationId ?? i}`} className="rounded border p-2 break-words" data-bo-tco-start-candidate={x.reason}>
              <span className="font-medium">{x.kind === 'CANONICAL' ? 'Fiche du bien' : <>Opération <Link className="underline" href={`/admin/operations/${x.operationId}?accountId=${accountId}`}>#{x.operationId}</Link> · {x.label}</>}</span>
              {' · '}{x.date ? jj(x.date) : x.rawDate ? `« ${x.rawDate} »` : 'sans date'}{x.dateField ? ` (${x.dateField})` : ''}
              {x.role ? ` · rôle ${x.role}` : ''}{x.strongProof ? ' · achat prouvé' : ''}
              <p className={x.accepted ? 'text-[color:var(--text-success)]' : 'text-muted-foreground'}>{ACQUISITION_CANDIDATE_REASON_LABELS[x.reason] ?? x.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TcoDiagnosticView({ data }: { data: TcoDiagnosticResponse }) {
  const t = data.tco;
  const { labels } = data;
  return (
    <div className="space-y-4" data-bo-tco>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Coût cumulé documenté</p><p className="text-lg font-semibold tabular-nums">{eur(t.summary.cumulativeCostCents)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Acquisition / complémentaires</p><p className="tabular-nums">{eur(t.summary.acquisitionCents)} / {eur(t.summary.additionalCostsCents)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Statut du calcul</p><p>{t.status}{t.summary.acquisitionStatus && t.summary.acquisitionStatus !== 'DOCUMENTED' ? ` · acquisition ${t.summary.acquisitionStatus === 'MISSING' ? 'inconnue' : 'sans objet'}` : ''}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Lignes examinées</p><p>{t.lines.length} ({t.reliability.operationsCounted} opération(s), {t.reliability.documentsCounted} justificatif(s) direct(s) comptés)</p></div>
        {/* Lot 111F : mêmes indicateurs que la fiche (moteur) — coût annuel moyen hors prix d'achat, coût net, financement. */}
        {t.indicators && (
          <div className="rounded-lg border p-3 sm:col-span-2 lg:col-span-4" data-bo-tco-indicators>
            <p className="text-xs text-muted-foreground">Indicateurs de la fiche (lot 111F)</p>
            <p className="tabular-nums">
              Coût annuel moyen : {t.indicators.annualAverage.cents != null ? `${eur(t.indicators.annualAverage.cents)} / an` : `– (${t.indicators.annualAverage.unavailableReason})`}
              {' · '}prix d’achat retiré : {t.annual.average.acquisitionPriceCents != null ? eur(t.annual.average.acquisitionPriceCents) : '–'}
              {' · '}{t.indicators.net.kind === 'FINAL' ? 'coût net final' : 'coût net estimé'} : {t.indicators.net.cents != null ? eur(t.indicators.net.cents) : '–'}
              {' · '}crédit à date : {eur(t.indicators.financing.costToDateCents)} ({t.indicators.financing.loans.length} prêt(s){t.indicators.financing.contractualTotalCents != null ? `, prévisionnel ${eur(t.indicators.financing.contractualTotalCents)}` : ''})
            </p>
            {/* Lot 112D : capital restant dû par prêt (méthode, date, conditions retenues et leur origine, ce qui manque) — jamais un coût. */}
            {t.indicators.financing.loans.filter((p) => p.outstanding).map((p) => (
              <p key={p.key} className="text-xs tabular-nums" data-bo-tco-outstanding={p.outstanding!.status}>
                {p.label} — capital restant dû : {p.outstanding!.cents != null ? eur(p.outstanding!.cents) : 'non établi'}
                {p.outstanding!.asOf ? ` au ${p.outstanding!.asOf}` : ''}
                {p.outstanding!.method ? ` · ${p.outstanding!.method}` : ''}
                {p.outstanding!.computeIssue ? ` · calcul : ${p.outstanding!.computeIssue}` : ''}
                {Object.keys(p.outstanding!.terms).length ? ` · conditions : ${Object.entries(p.outstanding!.terms).map(([k, v]) => `${k}=${typeof v?.value === 'object' ? JSON.stringify(v?.value) : String(v?.value)} (${v?.origin})`).join(', ')}` : ''}
                {p.outstanding!.missing.length ? ` · manque : ${p.outstanding!.missing.join(', ')}` : ''}
              </p>
            ))}
          </div>
        )}
      </div>
      {t.reliability.warnings.length > 0 && (
        <ul className="text-xs text-[color:var(--text-warning-soft)] list-disc pl-5 space-y-0.5">
          {t.reliability.warnings.map((w) => <li key={w}>{labels.warning[w] ?? w}</li>)}
        </ul>
      )}
      {data.diagnostics && <DiagnosticsBo d={data.diagnostics} />}
      {t.reliability.anomalies.length > 0 && (
        <p className="text-xs text-[color:var(--text-danger)]">Anomalies de contrôle : {t.reliability.anomalies.map((a) => `${a.code}${a.detail ? ` (${a.detail})` : ''}`).join(', ')}</p>
      )}

      <DepartDiagnostic t={t} accountId={data.accountId} />

      {/* Lot 108C : dépenses d'usage — complément estimé (même calcul que la fiche). */}
      <TcoUsageDiagnostic t={t} />

      {(t.citedOnlyDocuments?.length ?? 0) > 0 && (
        <div className="rounded-lg border p-3 text-xs space-y-1" data-bo-tco-cited>
          <p className="font-medium text-sm">Justificatifs qui citent seulement ce bien (non rattachés, exclus du calcul)</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {t.citedOnlyDocuments!.map((d) => <li key={d.fileId} className="break-words">#{d.fileId} · {d.title}</li>)}
          </ul>
        </div>
      )}

      {/* Mobile : cartes */}
      <div className="space-y-2 md:hidden">
        {t.lines.map((l) => (
          <div key={l.id} className="rounded-lg border p-3 text-sm space-y-1" data-bo-tco-line={l.id}>
            <div className="flex items-start justify-between gap-2"><span className="font-medium break-words min-w-0">{l.label}</span><Badge l={l} labels={labels} /></div>
            <p className="text-xs text-muted-foreground break-all">{l.id} · {SOURCE[l.source]} · {l.provenance}{l.category ? ` · ${l.category}` : ''}</p>
            <p className="text-xs tabular-nums">{montant(l)} → retenu {eur(l.includedCents)}</p>
            <Incertaine l={l} />
            {l.reason && <p className="text-xs text-muted-foreground">{labels.reason[l.reason] ?? l.reason}</p>}
            {l.note && <p className="text-xs text-muted-foreground">{l.note}</p>}
            <Masquee id={l.id} data={data} />
            <p className="text-xs">
              {l.fileId ? <span>doc #{l.fileId}</span> : null}
              {l.operationId ? <> · <Link className="underline" href={`/admin/operations/${l.operationId}?accountId=${data.accountId}`}>Opération #{l.operationId}</Link></> : null}
            </p>
          </div>
        ))}
      </div>

      {/* Desktop : tableau */}
      <div className="hidden md:block overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Ligne</th><th className="p-2">Source</th><th className="p-2">Document</th><th className="p-2">Opération</th>
              <th className="p-2">Catégorie</th><th className="p-2 text-right">Montant</th><th className="p-2 text-right">Retenu</th><th className="p-2">Statut et motif</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => (
              <tr key={l.id} className="border-t align-top" data-bo-tco-line={l.id}>
                <td className="p-2"><p className="font-medium">{l.label}</p><p className="text-xs text-muted-foreground">{l.id}{l.date ? ` · ${l.date}` : ''}</p></td>
                <td className="p-2 text-xs">{SOURCE[l.source]} · {l.provenance}</td>
                <td className="p-2 text-xs">{l.fileId ? `#${l.fileId}` : '—'}{l.relatedFileId ? ` (lié à #${l.relatedFileId})` : ''}</td>
                <td className="p-2 text-xs">{l.operationId ? <Link className="underline" href={`/admin/operations/${l.operationId}?accountId=${data.accountId}`}>#{l.operationId}</Link> : '—'}</td>
                <td className="p-2 text-xs">{l.category ?? '—'}</td>
                <td className="p-2 text-right tabular-nums text-xs">{montant(l)}</td>
                <td className="p-2 text-right tabular-nums">{eur(l.includedCents)}</td>
                <td className="p-2 text-xs"><Badge l={l} labels={labels} />{l.reason && <p className="mt-1 text-muted-foreground">{labels.reason[l.reason] ?? l.reason}</p>}{l.note && <p className="text-muted-foreground">{l.note}</p>}<Incertaine l={l} /><Masquee id={l.id} data={data} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
