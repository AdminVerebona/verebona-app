'use client';

/**
 * Qualification par couple — lot 86A (CDC Pilotage IA V2 P5 : ACT-02, BO-06,
 * BO-10, R05, R06 ; décisions PO n° 06, 12, 14, 15).
 *
 * Section repliée de Configuration IA (écran existant, aucun nouvel écran) :
 *   · pour la version active (ou celle ouverte dans l'éditeur), chaque couple
 *     opération × rang × modèle avec son état — jamais testé, en test,
 *     admissible, refusée, non concluante, obsolète (et ce qui a changé) ;
 *     un choix MANUEL sans preuve admissible est affiché « non testé »,
 *     jamais « qualifié » ;
 *   · « Tester ce couple » : test manuel facultatif (jamais exigé pour
 *     activer), exécuté en tâche de fond après un point de restauration ;
 *   · candidates automatiques (versions NON actives) et leur état ;
 *   · seuils de qualification : portés par le CODE, en LECTURE seule ;
 *   · campagnes récentes (détail dans Exécutions & logs › vue technique).
 * Cartes empilées : même composant en desktop (2 colonnes) et en mobile
 * (1 colonne), aucune table à défilement horizontal ; boutons ≥ 44 px.
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

type State = 'NEVER_TESTED' | 'TESTING' | 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE' | 'OBSOLETE';
interface Couple {
  treatment: string; operationCode: string; operationLabel: string; rank: number; model: string;
  profile: { reasoning: string | null; maxOutputTokens: number | null; timeoutMs: number };
  technicalRefusal: { parameter: string | null; message: string } | null;
  state: State; stateLabel: string; evidenceId: number | null; verdictAt: string | null; changed: string[]; choiceLabel: string | null;
}
interface Overview {
  readAt: string; environment: string;
  campaignsAllowed: { allowed: boolean; reason: string | null };
  thresholds: {
    version: string; quality: Array<{ category: string; label: string; max: number }>; mandatoryValidatedPercent: number;
    latency: { withinCapPercent: number; percentile: number; maxDegradationPercent: number };
    concurrency: { queuedPerWorker: number; queuedPerTreatment: number; synchronousSimultaneous: number; synchronousTreatments: string[] };
    transientRetries: number;
  };
  version: { id: number; visibleNumber: number | null; label: string | null; active: boolean; origin: string; candidateState: string | null } | null;
  couples: Couple[];
  candidates: Array<{ id: number; visibleNumber: number | null; label: string | null; state: string | null; reason: string | null; active: boolean; createdAt: string }>;
  campaigns: Array<{ id: number; kind: string; status: string; createdAt: string; finishedAt: string | null; restorePointId: string | null; refusal: string | null; error: string | null; couples: number | null; activatedVersionId: number | null }>;
}

const TONE: Record<State, string> = {
  ADMISSIBLE: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  REFUSED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  INCONCLUSIVE: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)] border-[color:var(--border-warning)]',
  OBSOLETE: 'bg-[color:var(--bg-page)] text-[color:var(--text-warning-soft)] border-[color:var(--border-subtle)]',
  TESTING: 'bg-[color:var(--accent-soft)] text-[color:var(--text-primary)] border-[color:var(--border-subtle)]',
  NEVER_TESTED: 'bg-[color:var(--bg-page)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};
const CAND: Record<string, string> = {
  CREATED: 'créée', QUALIFYING: 'en test', QUALIFIED: 'qualifiée', REFUSED: 'refusée', INCONCLUSIVE: 'non concluante', ACTIVATED: 'activée (préproduction)', NOT_CHOSEN: 'non retenue',
};
const CAMPAGNE: Record<string, string> = { PENDING: 'en attente', RUNNING: 'en cours', COMPLETED: 'terminée', REFUSED: 'refusée', INTERRUPTED: 'interrompue', FAILED: 'en échec' };
const RANG = ['principal', 'repli 1', 'repli 2'];

export function CoupleQualification({ versionId }: { versionId?: number | null }) {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Overview>(`/api/admin/ai/qualification${versionId ? `?versionId=${versionId}` : ''}`));
    } catch {
      toast.error('Qualification par couple indisponible.');
    }
  }, [versionId]);

  const tester = async (c: Couple) => {
    const k = `${c.operationCode}|${c.rank}`;
    setBusy(k);
    try {
      const r = await apiClient.post<{ campaignId: number }>('/api/admin/ai/qualification', {
        couple: { treatment: c.treatment, operationCode: c.operationCode, rank: c.rank, versionId: data?.version?.id ?? null },
      });
      toast.success(`Test lancé (campagne ${r.campaignId}) : point de restauration puis cas du corpus et rejeux.`);
      await load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Test impossible.');
    } finally {
      setBusy(null);
    }
  };

  const parTraitement = new Map<string, Couple[]>();
  for (const c of data?.couples ?? []) parTraitement.set(c.treatment, [...(parTraitement.get(c.treatment) ?? []), c]);
  const aTester = data?.couples.filter((c) => c.state !== 'ADMISSIBLE').length ?? 0;

  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="couple-qualification"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Qualification par couple · preuves, seuils, candidates
        {data && aTester > 0 && <span className="ml-2 text-xs text-[color:var(--text-warning-soft)]">• {aTester} couple(s) sans preuve admissible</span>}
      </summary>
      {!data ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-4 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex-1 min-w-0 text-xs text-[color:var(--text-muted)] break-words">
              {data.version
                ? `Version v${data.version.visibleNumber ?? data.version.id}${data.version.label ? ` « ${data.version.label} »` : ''} — ${data.version.active ? 'active' : 'non active'}, ${data.version.origin === 'auto' ? `candidate automatique (${CAND[data.version.candidateState ?? ''] ?? '—'})` : 'choix manuel'}.`
                : 'Aucune configuration active.'}
              {' '}Lecture : {formatDateTime(data.readAt)}.
            </p>
            <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
            </Button>
          </div>
          {!data.campaignsAllowed.allowed && (
            <p className="text-xs rounded-lg border border-[color:var(--border-subtle)] p-2 text-[color:var(--text-secondary)]">{data.campaignsAllowed.reason}</p>
          )}

          {[...parTraitement.entries()].map(([t, couples]) => (
            <div key={t} className="space-y-2">
              <h3 className="text-sm font-medium text-[color:var(--text-primary)]">{t}</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {couples.map((c) => (
                  <div key={`${c.operationCode}|${c.rank}`} data-testid="qualification-couple"
                    className="rounded-lg border border-[color:var(--border-subtle)] p-3 space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${TONE[c.state]}`}>{c.stateLabel}</span>
                      {c.choiceLabel && c.state !== 'ADMISSIBLE' && <span className="text-xs text-[color:var(--text-warning-soft)]">{c.choiceLabel}</span>}
                    </div>
                    <p className="text-sm text-[color:var(--text-primary)] break-words">{c.operationLabel}</p>
                    <p className="text-xs text-[color:var(--text-secondary)] break-words">
                      {RANG[c.rank] ?? `rang ${c.rank}`} · {c.model} · raisonnement {c.profile.reasoning ?? 'par défaut'} · sortie {c.profile.maxOutputTokens?.toLocaleString('fr-FR') ?? 'défaut'} · délai {Math.round(c.profile.timeoutMs / 1000)} s
                    </p>
                    {c.technicalRefusal && <p className="text-xs text-[color:var(--text-warning-soft)] break-words">Incompatible avant appel : {c.technicalRefusal.message}</p>}
                    {c.state === 'OBSOLETE' && c.changed.length > 0 && <p className="text-xs text-[color:var(--text-muted)] break-words">Changé depuis la preuve : {c.changed.join(', ')}.</p>}
                    {c.verdictAt && <p className="text-xs text-[color:var(--text-muted)]">Preuve n° {c.evidenceId} du {formatDateTime(c.verdictAt)}</p>}
                    <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" disabled={!data.campaignsAllowed.allowed || busy !== null || c.state === 'TESTING'}
                      onClick={() => void tester(c)}>
                      <FlaskConical className="w-3.5 h-3.5 mr-1.5" /> {busy === `${c.operationCode}|${c.rank}` ? 'Lancement…' : 'Tester ce couple'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="space-y-1">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">Candidates automatiques</h3>
            {data.candidates.length === 0 ? (
              <p className="text-xs text-[color:var(--text-muted)]">Aucune candidate : l’optimisation de préproduction n’en a pas proposé.</p>
            ) : data.candidates.map((v) => (
              <p key={v.id} className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="qualification-candidate">
                v{v.visibleNumber ?? v.id} {v.label ? `« ${v.label} »` : ''} — {CAND[v.state ?? ''] ?? '—'}{v.reason ? ` : ${v.reason}` : ''} ({formatDateTime(v.createdAt)})
              </p>
            ))}
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Seuils de qualification ({data.thresholds.version}, portés par le code — lecture seule)</summary>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-[color:var(--text-secondary)]" data-testid="qualification-thresholds">
              <div className="rounded-lg border border-[color:var(--border-subtle)] p-2 space-y-0.5">
                <p className="font-medium text-[color:var(--text-primary)]">Qualité (éliminatoire)</p>
                {data.thresholds.quality.map((q) => <p key={q.category}>{q.label} : {q.max}</p>)}
                <p>Cas obligatoires exécutés et validés : {data.thresholds.mandatoryValidatedPercent} %</p>
                <p>Résultat non vérifiable : non concluant.</p>
              </div>
              <div className="rounded-lg border border-[color:var(--border-subtle)] p-2 space-y-0.5">
                <p className="font-medium text-[color:var(--text-primary)]">Délai et concurrence</p>
                <p>Appels sous le plafond de l’opération : {data.thresholds.latency.withinCapPercent} %</p>
                <p>P{data.thresholds.latency.percentile} : au plus +{data.thresholds.latency.maxDegradationPercent} % par rapport au modèle actif</p>
                <p>File : {data.thresholds.concurrency.queuedPerWorker} par worker, dont {data.thresholds.concurrency.queuedPerTreatment} par traitement</p>
                <p>{data.thresholds.concurrency.synchronousTreatments.join(' et ')} : {data.thresholds.concurrency.synchronousSimultaneous} appels simultanés</p>
                <p>Erreur fournisseur transitoire : non concluant, {data.thresholds.transientRetries} nouvel essai</p>
              </div>
            </div>
          </details>

          <div className="space-y-1">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">Campagnes récentes</h3>
            {data.campaigns.length === 0 ? <p className="text-xs text-[color:var(--text-muted)]">Aucune campagne.</p> : data.campaigns.slice(0, 8).map((c) => (
              <p key={c.id} className="text-xs text-[color:var(--text-secondary)] break-words">
                n° {c.id} · {c.kind === 'AUTO' ? 'automatique' : 'test manuel'} · {CAMPAGNE[c.status] ?? c.status} · {formatDateTime(c.createdAt)}
                {c.couples != null ? ` · ${c.couples} couple(s)` : ''}{c.restorePointId ? ' · point de restauration pris' : ''}
                {c.activatedVersionId ? ` · candidate v${c.activatedVersionId} activée` : ''}{c.refusal ? ` — ${c.refusal}` : ''}{c.error ? ` — ${c.error}` : ''}
              </p>
            ))}
            <p className="text-xs text-[color:var(--text-muted)]">Détail des cas et des preuves : Exécutions &amp; logs › vue technique › Qualification.</p>
          </div>
        </div>
      )}
    </details>
  );
}
