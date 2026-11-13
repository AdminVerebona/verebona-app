"use client";

/**
 * Lot 113AQ (Trello #751) — anomalie IDENTITY_ATTRIBUTE_CONFLICT (BO #12) :
 * synthèse DATÉE, compteurs distincts (signalements ≠ conflits actifs ≠
 * divergences légitimes ≠ arbitrages ≠ résolus ≠ contrôles échoués), état de
 * l'alerte et sa raison, tableau par Opération × attribut (compte EXPLICITE),
 * valeurs côte à côte avec rôle et source, « non vérifiable » motivé, lecture
 * chronologique des signalements (évolution de population, répétitions,
 * « détail historique non conservé »).
 *
 * Lecture seule : la route `GET /api/admin/anomalies/[id]/conflicts` ne
 * mute rien et n'appelle aucune IA. Libellés techniques du BO (admin).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/admin/format';
import type { ConflictDiagnostic } from '@/services/business-operations/diagnostics/attribute-conflicts-read';
import type { ConflictDiagnosticEntry, ConflictLineState } from '@/services/business-operations/diagnostics/attribute-conflicts-model';

const LINE_STATE: Record<ConflictLineState, { label: string; cls: string }> = {
  ACTIVE: { label: 'Active', cls: 'text-[color:var(--text-danger)]' },
  NON_VERIFIABLE: { label: 'Non vérifiable', cls: 'text-[color:var(--text-warning-soft)]' },
  RESOLVED: { label: 'Résolue', cls: 'text-[color:var(--text-success)]' },
  NOT_A_CONFLICT: { label: 'Pas un conflit', cls: 'text-[color:var(--text-secondary)]' },
  HISTORICAL: { label: 'Historique', cls: 'text-[color:var(--text-muted)]' },
};

const MAINTIEN: Record<string, string> = {
  ACTIVE_CONFLICTS: 'conflit(s) actif(s) vérifié(s)',
  NON_VERIFIABLE: 'ligne(s) non vérifiable(s) — aucune fermeture implicite',
  BOTH: 'conflit(s) actif(s) et ligne(s) non vérifiable(s)',
  NONE: 'aucune ligne active ni non vérifiable sur cette page',
};

const OCC_KIND: Record<string, string> = {
  FIRST: 'Première détection',
  POPULATION_CHANGE: 'Évolution de la population',
  DETAIL_CHANGE: 'Évolution du détail (valeurs / verdicts)',
  PERIODIC_REPEAT: 'Répétition périodique (aucun fait nouveau)',
};

function Count({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-medium">{value === null ? 'non mesuré' : value}</p>
    </div>
  );
}

function Values({ e }: { e: ConflictDiagnosticEntry }) {
  return (
    <div className="flex flex-wrap gap-2">
      {e.values.map((v, i) => (
        <div key={`${v.raw}-${i}`} className={`rounded-md border p-2 min-w-[12rem] ${v.retained ? 'border-[color:var(--border-success)]' : ''}`}>
          <p className="font-medium break-all">{v.raw || '—'}{v.retained && <span className="ml-1 text-xs text-[color:var(--text-success)]">(retenue)</span>}</p>
          {v.normalized && v.normalized !== v.raw && <p className="text-xs text-muted-foreground break-all">normalisée : {v.normalized}</p>}
          <p className="text-xs">Rôle : {v.roleLabel}</p>
          <ul className="text-xs text-muted-foreground">
            {v.sources.map((s) => (
              <li key={s.sourceId}>
                source #{s.sourceId}{s.fileId ? <> · document #{s.fileId}</> : null}{s.documentRole ? ` · ${s.documentRole}` : ''}
                {s.authority ? ` · ${s.authority}` : ''}{s.availability !== 'EXISTING' ? ` · ${s.availability === 'MISSING' ? 'introuvable' : s.availability === 'DELETED' ? 'document supprimé' : 'inactive'}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AttributeConflictsPanel({ id }: { id: number }) {
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'alerting' | 'all'>('alerting');
  const [data, setData] = useState<ConflictDiagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/anomalies/${id}/conflicts?page=${page}&scope=${scope}`, { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `Erreur ${res.status}`); setData(null); return; }
      setData(body.diagnostic as ConflictDiagnostic);
    } catch {
      setError('Erreur réseau — diagnostic non chargé.');
    } finally {
      setLoading(false);
    }
  }, [id, page, scope]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) return <div className="rounded-xl border bg-card p-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error || !data) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-2" data-testid="conflits-attributs">
        <p className="text-sm font-medium">Diagnostic des contradictions d’attributs</p>
        <p className="text-sm text-[color:var(--text-danger)]">{error ?? 'Diagnostic indisponible.'} Aucun verdict n’est affiché à sa place.</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>Réessayer</Button>
      </div>
    );
  }
  const c = data.counters;
  return (
    <div className="rounded-xl border bg-card p-4 space-y-4" data-testid="conflits-attributs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Diagnostic des contradictions d’attributs (par Opération)</p>
          <p className="text-xs text-muted-foreground">
            État lu le {formatDateTime(data.generatedAt)} (Europe/Paris) — {data.generatedAt} · contrat {data.contract}/{data.contractVersion} · règles {data.rules.id} · lecture seule
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={scope === 'alerting' ? 'default' : 'outline'} size="sm" onClick={() => { setScope('alerting'); setPage(1); }}>Lignes de l’alerte</Button>
          <Button variant={scope === 'all' ? 'default' : 'outline'} size="sm" onClick={() => { setScope('all'); setPage(1); }}>Tous les faits divergents</Button>
        </div>
      </div>

      <p className="text-sm">
        Alerte {data.alert.anomalyStatus === 'open' ? 'ouverte' : data.alert.anomalyStatus === 'resolved' ? 'résolue' : '—'} — maintenue par : {MAINTIEN[data.alert.maintainedBy]}.
        <span className="block text-xs text-muted-foreground">{data.alert.closingRule}</span>
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <Count label="Signalements (occurrences)" value={c.occurrences} />
        <Count label="Signalements matériels" value={c.materialOccurrences} />
        <Count label="Répétitions périodiques" value={c.periodicReports} />
        <Count label="Opérations concernées" value={c.operations} />
        <Count label="Attributs concernés" value={c.attributes} />
        <Count label="Conflits actifs vérifiés" value={c.activeConflicts} />
        <Count label="Non vérifiables" value={c.nonVerifiable} />
        <Count label="Divergences légitimes" value={c.legitimateDifferences} />
        <Count label="Résolus" value={c.resolved} />
        <Count label="Arbitrages ouverts" value={c.openArbitrations} />
        <Count label="Contrôles échoués" value={c.checksFailed} />
        <Count label="Rattachements douteux" value={c.linkErrorsSuspected} />
      </div>
      {data.limits.length > 0 && (
        <ul className="text-xs text-[color:var(--text-warning-soft)] list-disc pl-4">{data.limits.map((l) => <li key={l}>{l}</li>)}</ul>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="px-2 py-2 font-medium">Compte</th>
              <th className="px-2 py-2 font-medium">Opération</th>
              <th className="px-2 py-2 font-medium">Attribut · rôle</th>
              <th className="px-2 py-2 font-medium">Valeurs (côte à côte)</th>
              <th className="px-2 py-2 font-medium">Retenue / persistée</th>
              <th className="px-2 py-2 font-medium">Verdict · raison</th>
              <th className="px-2 py-2 font-medium">Dernier contrôle</th>
              <th className="px-2 py-2 font-medium">Incidence · action</th>
              <th className="px-2 py-2 font-medium">État de la ligne</th>
            </tr>
          </thead>
          <tbody>
            {data.conflicts.map((e, i) => (
              <tr key={`${e.accountId}-${e.operationId}-${e.attribute.key}-${e.origin}-${i}`} className="border-b last:border-b-0 align-top" data-testid="conflit-ligne">
                <td className="px-2 py-2"><Link className="hover:underline" href={`/admin/accounts/${e.accountId}`}>#{e.accountId}</Link></td>
                <td className="px-2 py-2">
                  <Link className="hover:underline" href={e.operation.boLink}>#{e.operationId}</Link>
                  <span className="block text-xs text-muted-foreground">{e.operation.type ?? 'type non qualifié'}{e.operation.availability !== 'EXISTING' ? ` · ${e.operation.availability === 'MERGED' ? 'fusionnée' : 'invalidée'}` : ''}</span>
                </td>
                <td className="px-2 py-2">{e.attribute.label}<span className="block text-xs text-muted-foreground">{e.role.known ? e.role.label : `rôle non établi${e.role.code !== 'UNKNOWN' ? ` (${e.role.label})` : ''}`}</span></td>
                <td className="px-2 py-2"><Values e={e} /></td>
                <td className="px-2 py-2 text-xs">retenue : {e.retainedValue ?? 'aucune'}<br />persistée : {e.persistedValue ?? 'aucune'}{e.protection ? <><br />protection : {e.protection}</> : null}</td>
                <td className="px-2 py-2 text-xs"><span className="font-medium">{e.qualificationLabel}</span><br />{e.reason}</td>
                <td className="px-2 py-2 text-xs whitespace-nowrap">
                  {e.lastCheck.at ? formatDateTime(e.lastCheck.at) : 'inconnu'}<br />{e.lastCheck.rules} · {e.lastCheck.result}
                  {!e.lastCheck.fresh && <span className="block text-[color:var(--text-warning-soft)]">non récent</span>}
                </td>
                <td className="px-2 py-2 text-xs">
                  {e.impact.status === 'NONE' ? 'aucune incidence' : e.impact.status === 'NOT_ESTABLISHED' ? 'incidence non établie' : `à vérifier : ${e.impact.scopes.join(', ')}`}
                  <br />{e.appliedAction.detail}
                  {e.arbitration && <><br />« À traiter » #{e.arbitration.actionId} ({e.arbitration.state === 'OPEN' ? 'ouverte' : 'traitée'})</>}
                  {e.t3 && (
                    <span className="block text-muted-foreground" data-testid="conflit-t3">
                      T3 #{e.t3.reviewId} : {e.t3.label}{e.t3.outcome ? ` — ${e.t3.outcome}` : ''}{e.t3.decidedAt ? ` · ${formatDateTime(e.t3.decidedAt)}` : ''}
                      {e.t3.reason ? <><br />motif : {e.t3.reason}</> : null}
                      {e.t3.evidence.map((p, j) => <span className="block" key={j}>preuve{p.fileId ? ` (document #${p.fileId})` : ''} : « {p.excerpt} »</span>)}
                      {e.t3.promptVersion ? <><br />prompt : {e.t3.promptVersion}{e.t3.traceId ? ` · trace ${e.t3.traceId}` : ''}</> : null}
                    </span>
                  )}
                </td>
                <td className={`px-2 py-2 text-xs ${LINE_STATE[e.lineState].cls}`}>{LINE_STATE[e.lineState].label}<span className="block text-muted-foreground">{e.lineStateReason}</span></td>
              </tr>
            ))}
            {data.conflicts.length === 0 && (
              <tr><td colSpan={9} className="px-2 py-3 text-sm text-muted-foreground">Aucune ligne {scope === 'alerting' ? 'active ou non vérifiable' : 'de fait divergent'} au dernier contrôle persisté.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {data.totalPages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Précédente</Button>
          <span>Page {data.page} / {data.totalPages} ({data.totalOperations} Opérations)</span>
          <Button variant="outline" size="sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>Suivante</Button>
        </div>
      )}

      {data.occurrences.length > 0 && (
        <div className="overflow-x-auto">
          <p className="text-sm font-medium">Lecture des signalements</p>
          <table className="w-full text-sm mt-1">
            <thead><tr className="text-left text-xs text-muted-foreground border-b"><th className="px-2 py-1 font-medium">Date</th><th className="px-2 py-1 font-medium">Nature</th><th className="px-2 py-1 font-medium">Opérations</th><th className="px-2 py-1 font-medium">Détail</th></tr></thead>
            <tbody>
              {data.occurrences.map((o) => (
                <tr key={o.id} className="border-b last:border-b-0">
                  <td className="px-2 py-1 whitespace-nowrap">{formatDateTime(o.at)}</td>
                  <td className="px-2 py-1">{OCC_KIND[o.kind]}{o.added.length ? ` : + #${o.added.join(', #')}` : ''}{o.removed.length ? ` ; − #${o.removed.join(', #')}` : ''}</td>
                  <td className="px-2 py-1 text-xs">{o.operationIds.length ? `#${o.operationIds.join(', #')}` : '—'}</td>
                  <td className="px-2 py-1 text-xs">{o.detail === 'STRUCTURED' ? 'structuré' : o.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
