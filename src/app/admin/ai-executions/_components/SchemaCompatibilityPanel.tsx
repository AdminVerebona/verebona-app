'use client';

/**
 * Exécutions & logs › vue technique › Schémas structurés — lot 114 (carte
 * #776, travail 10 ; cahier des charges §6, AC17).
 *
 * Ce que la passerelle a RÉELLEMENT transmis au fournisseur : appels portant
 * le schéma imposé et acceptés, refus HTTP 400, nouveaux essais sans schéma,
 * appels restés en mode JSON à cause d'un refus mémorisé — une réussite
 * finale n'est jamais présentée comme « aucun incident ». Filtres : période,
 * opération, modèle, version du contrat. Puis la mémoire de compatibilité par
 * couple (état, motif, prochain essai) et la projection courante de chaque
 * contrat. Compteurs, codes, versions et empreintes seulement.
 * Desktop et mobile : cartes empilées, aucun tableau à défilement horizontal.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

interface Rates { acceptedRate: number | null; refusal400Rate: number | null; jsonModeRate: number | null; requestsPerCall: number | null }
interface Counts {
  calls: number; schemaSent: number; schemaAccepted: number; schemaRefused400: number; schemaFailedOther: number;
  retriesWithoutSchema: number; answeredAfterRetry: number; skippedKnownRejection: number; omittedStatic: number; notRequested: number;
  retests: number; finalSuccess: number; providerRequests: number; inputTokens: number; outputTokens: number; costMicros: number | null; failedAttemptMs: number;
}
interface Group extends Counts {
  operationCode: string; model: string; contractId: string | null; contractVersion: number | null; schemaHash: string | null;
  providerSchemaHash: string | null; durationP50Ms: number | null; durationP95Ms: number | null; rates: Rates;
}
interface Day { day: string; calls: number; schemaAccepted: number; schemaRefused400: number; skippedKnownRejection: number; notRequested: number; acceptedRate: number | null }
interface Couple {
  keyId: string; model: string; operationCode: string; contractId: string; contractVersion: number; schemaHash: string;
  providerSchemaHash: string | null; adapterVersion: string; state: string; stateLabel: string; reason: string | null; current: boolean;
  acceptedCount: number; rejectionCount: number; consecutiveRejections: number; retestCount: number;
  lastRejectedAt: string | null; lastAcceptedAt: string | null; nextRetestAt: string | null; retestInProgress: boolean;
  lastHttpStatus: number | null; lastProviderCode: string | null; appVersion: string | null;
}
interface StaticRow {
  operationCode: string; contractId: string; contractVersion: number; schemaHash: string; providerSchemaHash: string | null;
  adapterVersion: string; nodes: number; serializedChars: number | null; omitted: string | null; droppedKeywords: string[]; issues: string[]; lostBranches: string[];
}
interface Overview {
  usage: { days: number; totals: Counts & { rates: Rates }; groups: Group[]; trend: Day[]; unavailable: string | null };
  couples: Couple[] | null; staticMatrix: StaticRow[]; openAlerts: number | null; appVersion: string | null;
  policy: { version: number; firstRetestMs: number; retestAfterQualifiedMs: number; maxRetestMs: number };
}
interface Bilan { examined: number; resolved: Record<string, number>; keptActive: number; keptUndetermined: number; raised: number; unavailable: boolean }

const pct = (v: number | null): string => (v === null ? 'non mesurable' : `${(v * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const euros = (micros: number | null): string => (micros === null ? 'non calculable' : `${(micros / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} €`);
const heures = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;

/** Motifs d'état (libellés à valider par le PO). */
const MOTIF: Record<string, string> = {
  EXPLICIT_SCHEMA_REJECTION: 'schéma refusé explicitement par le fournisseur',
  GENERIC_400_ANSWERED_WITHOUT_SCHEMA: 'requête avec schéma refusée (HTTP 400 sans précision), réponse obtenue sans schéma',
  ACCEPTED_ON_REAL_CALL: 'réponse du fournisseur à un appel réel portant le schéma',
  RETEST_INCONCLUSIVE: 'dernier essai avec schéma sans conclusion (délai, réseau ou autre refus)',
};
const motifOf = (r: string | null): string => (r === null ? '—' : MOTIF[r] ?? (r.startsWith('STATIC_') ? `contrôle statique : ${r.slice(7)}` : r));

function Ligne({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-xs text-[color:var(--text-secondary)] break-words">
      <span className="text-[color:var(--text-muted)]">{label} : </span>{children}
    </p>
  );
}

export function SchemaCompatibilityPanel({ initialOperation = '' }: { initialOperation?: string }) {
  const [days, setDays] = useState('7');
  const [operation, setOperation] = useState(initialOperation);
  const [model, setModel] = useState('');
  const [contractVersion, setContractVersion] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bilan, setBilan] = useState<Bilan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ days });
      if (operation) q.set('operation', operation);
      if (model) q.set('model', model);
      if (contractVersion) q.set('contractVersion', contractVersion);
      setData(await apiClient.get<Overview>(`/api/admin/ai/schema-compatibility?${q}`));
    } catch {
      toast.error('Suivi des schémas structurés indisponible.');
    } finally {
      setLoading(false);
    }
  }, [days, operation, model, contractVersion]);
  useEffect(() => { void load(); }, [load]);

  const reevaluer = async () => {
    setBusy(true);
    try {
      setBilan(await apiClient.post<Bilan>('/api/admin/ai/schema-compatibility/reevaluate', {}));
      await load();
    } catch {
      toast.error('Réévaluation des alertes impossible.');
    } finally {
      setBusy(false);
    }
  };

  const operations = [...new Set([...(data?.staticMatrix ?? []).map((s) => s.operationCode), ...(data?.usage.groups ?? []).map((g) => g.operationCode)])].sort();
  const models = [...new Set([...(data?.usage.groups ?? []).map((g) => g.model), ...(data?.couples ?? []).map((c) => c.model)])].sort();
  const t = data?.usage.totals;
  const champ = 'min-h-[44px] sm:min-h-0 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 py-1 text-sm text-[color:var(--text-primary)] min-w-0';

  return (
    <div className="space-y-4 min-w-0" data-testid="schema-compatibility">
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0">
        <p className="text-xs text-[color:var(--text-muted)] break-words">
          Usage réel du schéma de sortie imposé au fournisseur, mesuré sur les appels enregistrés. Une réussite finale peut contenir un refus puis un nouvel essai sans schéma : ils sont comptés ici. Aucun contenu de document ni de prompt.
        </p>
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center">
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Période
            <select className={champ} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Période">
              {['1', '7', '30', '90'].map((d) => <option key={d} value={d}>{d === '1' ? '24 heures' : `${d} jours`}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Type d’appel
            <select className={champ} value={operation} onChange={(e) => setOperation(e.target.value)} aria-label="Type d’appel">
              <option value="">Tous</option>
              {(operation && !operations.includes(operation) ? [operation, ...operations] : operations).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Modèle
            <select className={champ} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle">
              <option value="">Tous</option>
              {(model && !models.includes(model) ? [model, ...models] : models).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-xs text-[color:var(--text-secondary)] flex flex-col sm:flex-row sm:items-center gap-1">Version du contrat
            <input className={`${champ} sm:w-20`} inputMode="numeric" value={contractVersion} placeholder="toutes"
              onChange={(e) => setContractVersion(e.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="Version du contrat" />
          </label>
          <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()} disabled={loading}>Actualiser</Button>
        </div>

        {!data && <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>}
        {data?.usage.unavailable && (
          <p className="text-sm text-[color:var(--text-warning)] break-words">Mesure indisponible ({data.usage.unavailable}) : aucun indicateur n’est affiché plutôt qu’un zéro trompeur.</p>
        )}
        {data && !data.usage.unavailable && t && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2" data-testid="schema-usage-totals">
            {([
              ['Schéma imposé accepté', `${pct(t.rates.acceptedRate)}`, `${t.schemaAccepted} appel(s) sur ${t.calls - t.notRequested} où il était demandé`],
              ['Refus HTTP 400 avec schéma', String(t.schemaRefused400), `${pct(t.rates.refusal400Rate)} des requêtes portant le schéma`],
              ['Nouveaux essais sans schéma', String(t.retriesWithoutSchema), `${t.answeredAfterRetry} appel(s) ont abouti ainsi`],
              ['Sans schéma : refus mémorisé', String(t.skippedKnownRejection), `${t.omittedStatic} pour motif statique · ${t.notRequested} non demandé`],
              ['Réussite finale', `${t.finalSuccess} / ${t.calls}`, 'appels d’analyse ayant sollicité le fournisseur'],
              ['Requêtes fournisseur réelles', String(t.providerRequests), `${t.rates.requestsPerCall ?? '—'} par appel · ${t.retests} essai(s) de réexamen`],
              ['Jetons', `${t.inputTokens.toLocaleString('fr-FR')} / ${t.outputTokens.toLocaleString('fr-FR')}`, 'entrée / sortie'],
              ['Coût', euros(t.costMicros), `${Math.round(t.failedAttemptMs / 1000)} s passées dans des requêtes refusées ou en échec`],
            ] as const).map(([titre, valeur, detail]) => (
              <div key={titre} className="rounded-lg border border-[color:var(--border-subtle)] p-3 min-w-0">
                <p className="text-xs text-[color:var(--text-muted)] break-words">{titre}</p>
                <p className="text-lg font-semibold text-[color:var(--text-primary)] break-words">{valeur}</p>
                <p className="text-xs text-[color:var(--text-secondary)] break-words">{detail}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {data && !data.usage.unavailable && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">Par type d’appel, modèle et contrat</p>
          {data.usage.groups.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucun appel sur la période.</p>}
          {data.usage.groups.map((g) => (
            <div key={`${g.operationCode}|${g.model}|${g.schemaHash}|${g.providerSchemaHash}`} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-usage-group">
              <p className="text-sm text-[color:var(--text-primary)] break-words">
                {g.operationCode} · {g.model} · {g.contractId ?? 'contrat non tracé'}{g.contractVersion !== null ? ` v${g.contractVersion}` : ''}
              </p>
              <Ligne label="Empreintes">contrat {g.schemaHash ?? '—'} · schéma transmis {g.providerSchemaHash ?? '—'}</Ligne>
              <Ligne label="Schéma imposé accepté">{pct(g.rates.acceptedRate)} ({g.schemaAccepted} sur {g.calls - g.notRequested})</Ligne>
              <Ligne label="Refus HTTP 400 avec schéma">{g.schemaRefused400} · nouveaux essais sans schéma : {g.retriesWithoutSchema} · aboutis : {g.answeredAfterRetry}</Ligne>
              <Ligne label="Sans schéma">{g.skippedKnownRejection} par refus mémorisé · {g.omittedStatic} pour motif statique · {g.notRequested} non demandé</Ligne>
              <Ligne label="Appels">{g.calls} · réussite finale {g.finalSuccess} · requêtes fournisseur {g.providerRequests}</Ligne>
              <Ligne label="Jetons, coût, durée">{g.inputTokens.toLocaleString('fr-FR')} / {g.outputTokens.toLocaleString('fr-FR')} · {euros(g.costMicros)} · P50 {g.durationP50Ms ?? '—'} ms · P95 {g.durationP95Ms ?? '—'} ms</Ligne>
            </div>
          ))}
          {data.usage.trend.length > 1 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 flex items-center">Évolution par jour ({data.usage.trend.length} jours)</summary>
              <div className="mt-1 space-y-0.5">
                {data.usage.trend.map((d) => (
                  <p key={d.day} className="text-xs text-[color:var(--text-secondary)] break-words">
                    {d.day} · {d.calls} appel(s) · schéma accepté {pct(d.acceptedRate)} · refus 400 : {d.schemaRefused400} · sans schéma par refus mémorisé : {d.skippedKnownRejection}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex-1 min-w-0 text-sm font-medium text-[color:var(--text-primary)] break-words">
              Compatibilité mémorisée par couple{data.openAlerts !== null ? ` · ${data.openAlerts} alerte(s) de compatibilité ouverte(s)` : ''}
            </p>
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void reevaluer()} disabled={busy}>
              {busy ? 'Réévaluation…' : 'Réévaluer les alertes'}
            </Button>
          </div>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Mémoire partagée entre les instances et conservée après redémarrage. Après un refus, le schéma n’est plus transmis au couple ; un seul essai avec schéma est retenté après {heures(data.policy.firstRetestMs)} (délai doublé à chaque nouveau refus, au plus {heures(data.policy.maxRetestMs)} ; {heures(data.policy.retestAfterQualifiedMs)} si le couple avait déjà été accepté). Politique n° {data.policy.version}. Le fournisseur n’indique pas la cause d’un refus HTTP 400 sans précision.
          </p>
          {bilan && (
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="schema-reevaluation">
              Réévaluation : {bilan.examined} alerte(s) examinée(s) · {bilan.resolved.SCHEMA_ACCEPTED_AGAIN ?? 0} résolue(s) (schéma de nouveau accepté) · {bilan.resolved.SCHEMA_SUPERSEDED ?? 0} résolue(s) (contrat ou schéma remplacé) · {bilan.keptActive} conservée(s) (refus toujours actif) · {bilan.keptUndetermined} conservée(s) faute de preuve · {bilan.raised} levée(s){bilan.unavailable ? ' · lecture incomplète' : ''}
            </p>
          )}
          {data.couples === null && <p className="text-sm text-[color:var(--text-warning)]">Mémoire de compatibilité indisponible (migration 1710 non appliquée).</p>}
          {data.couples?.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucun couple observé pour ces filtres.</p>}
          {data.couples?.map((c) => (
            <div key={c.keyId} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-couple">
              <p className="text-sm text-[color:var(--text-primary)] break-words">
                {c.operationCode} · {c.model} · {c.contractId} v{c.contractVersion} —{' '}
                <span className={c.state === 'REJECTED_CONFIRMED' || c.state === 'NEEDS_RECHECK' ? 'text-[color:var(--text-warning)]' : ''}>{c.stateLabel}</span>
                {!c.current && <span className="text-[color:var(--text-muted)]"> (historique : ce schéma n’est plus celui transmis)</span>}
              </p>
              <Ligne label="Motif">{motifOf(c.reason)}{c.lastHttpStatus ? ` · HTTP ${c.lastHttpStatus}` : ''}{c.lastProviderCode ? ` ${c.lastProviderCode}` : ''}</Ligne>
              <Ligne label="Empreintes">contrat {c.schemaHash} · schéma transmis {c.providerSchemaHash ?? 'aucun'} · adaptateur {c.adapterVersion}</Ligne>
              <Ligne label="Constats">{c.acceptedCount} acceptation(s) relevée(s) · {c.rejectionCount} refus ({c.consecutiveRejections} consécutif(s)) · {c.retestCount} réexamen(s)</Ligne>
              <Ligne label="Dates">dernier refus {c.lastRejectedAt ? formatDateTime(c.lastRejectedAt) : '—'} · dernière acceptation {c.lastAcceptedAt ? formatDateTime(c.lastAcceptedAt) : '—'}
                {c.nextRetestAt ? ` · prochain essai avec schéma au plus tôt ${formatDateTime(c.nextRetestAt)}` : ''}{c.retestInProgress ? ' · essai en cours' : ''}</Ligne>
              {c.appVersion && <Ligne label="Version de l’application">{c.appVersion.slice(0, 12)}</Ligne>}
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-2 min-w-0">
          <p className="text-sm font-medium text-[color:var(--text-primary)] break-words">Schéma transmis aujourd’hui, par contrat (contrôle statique)</p>
          <p className="text-xs text-[color:var(--text-muted)] break-words">
            Calculé par cette version de l’application{data.appVersion ? ` (${data.appVersion.slice(0, 12)})` : ''}. Ce contrôle écarte les incompatibilités connues ; il ne prouve pas l’acceptation par le fournisseur, que seuls les appels réels établissent.
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)] min-h-[44px] sm:min-h-0 flex items-center">{data.staticMatrix.length} contrat(s)</summary>
            <div className="mt-1 space-y-2">
              {data.staticMatrix.map((s) => (
                <div key={s.operationCode} className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-0.5 min-w-0" data-testid="schema-static">
                  <p className="text-sm text-[color:var(--text-primary)] break-words">
                    {s.operationCode} · {s.contractId} v{s.contractVersion} — {s.omitted ? <span className="text-[color:var(--text-warning)]">non transmis ({s.omitted})</span> : 'transmissible'}
                  </p>
                  <Ligne label="Empreintes">contrat {s.schemaHash} · schéma transmis {s.providerSchemaHash ?? 'aucun'} · adaptateur {s.adapterVersion}</Ligne>
                  <Ligne label="Taille">{s.nodes} nœud(s){s.serializedChars !== null ? ` · ${s.serializedChars.toLocaleString('fr-FR')} caractères` : ''}</Ligne>
                  <Ligne label="Contraintes vérifiées par Verebona seulement">{s.droppedKeywords.length ? s.droppedKeywords.join(', ') : 'aucune'}</Ligne>
                  <Ligne label="Branches du contrat absentes du schéma transmis">{s.lostBranches.length ? s.lostBranches.join(', ') : 'aucune'}</Ligne>
                  {s.issues.length > 0 && <Ligne label="Écarts signalés">{s.issues.join(' ; ')}</Ligne>}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
