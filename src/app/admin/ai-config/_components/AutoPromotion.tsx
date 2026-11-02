'use client';

/**
 * Promotion automatique IA — lot 105B (ticket P1 « IA auto-amélioration », §5).
 *
 * Section repliée de Configuration IA (écran existant), lecture seule. Elle
 * dit l'ÉTAT RÉEL, sans jamais confondre :
 *   (a) planificateur lancé ;
 *   (b) tests réellement exécutés avec un compte technique valide (0 dit 0) ;
 *   (c) couverture du corpus et des risques (manques A1, référentiel) ;
 *   (d) blocages : verrou A1, compte technique, absence de preuve ;
 *   (e) candidates créées / qualifiées / bloquées A1 / refusées / activées /
 *       surveillées / restaurées ; journal (revalidations, relances, retours
 *       arrière).
 * « Automatique » n'est affiché qu'en cas de progrès effectif. Encart P2
 * « différé » explicite. Cartes empilées : desktop et mobile, aucune table à
 * défilement horizontal ; boutons ≥ 44 px en mobile ; charte Sérénité (tokens).
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

interface Status {
  readAt: string; environment: string;
  health: { code: string; automatic: boolean; label: string; cause: string | null; nextAction: string | null };
  scheduler: Array<{ code: string; launched: boolean; lastRunAt: string | null; lastStatus: string | null; nextRunAt: string | null; note: string | null; consecutiveFailures: number }>;
  executions: { days: number; campaigns: number; concludedCases: number; inconclusiveCases: number; providerCalls: number; costMicros: number; lastCampaignAt: string | null; blockedByPrerequisite: number; technicalAccount: { ok: boolean; code: string; label: string } | null };
  inventory: { version: string; counts: Record<string, number>; expected: Record<string, number>; zipReceived: boolean; manifestVersion: number; entries: number } | null;
  coverage: Array<{ treatment: string; blockers: number; structural: number; byCode: Array<{ code: string; label: string; n: number }>; requirements: { met: number; total: number; waived: Array<{ id: string; reason: string }> } }>;
  blocks: { a1Candidates: number; a1PromptIssues: number; openPromptIssues: number; account: { code: string; label: string; nextAction: string | null } | null; operationsWithEvidence30d: number; a1StructuralTreatments: string[] };
  candidates: { days: number; created: number; qualifying: number; qualified: number; blockedA1: number; refused: number; inconclusive: number; notChosen: number; activated: number; watching: number; rolledBack: number; suspended: number };
  events: Array<{ id: number; kind: string; candidateVersionId: number | null; treatment: string | null; allowed: boolean | null; code: string | null; message: string; createdAt: string }>;
  deferred: Array<{ title: string; needs: string[] }>;
  manualFlows: { manualActivation: string; production: string };
}

const TONE = {
  ok: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  warn: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning)] border-[color:var(--border-warning)]',
  ko: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
};

const TASK_LABELS: Record<string, string> = {
  'ai-catalog-sync': 'Catalogue des modèles',
  'ai-qualification-campaign': 'Qualification par couple et candidates',
  'ai-prompt-conformity': 'Conformité des prompts',
  'ai-promotion-watch': 'Surveillance post-activation',
};

const TOTAL_LABELS: Record<string, string> = {
  historical: 'historiques', toRevalidate: 'à revalider', newScenarios: 'nouveaux', stress: 'stress', pairs: 'paires A/B',
};

export function AutoPromotion() {
  const [data, setData] = useState<Status | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.get<Status>('/api/admin/ai/promotion'));
    } catch {
      toast.error('État de la promotion automatique indisponible.');
    }
  }, []);
  const h = data?.health;
  const c = data?.candidates;
  const x = data?.executions;
  return (
    <details
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]"
      data-testid="auto-promotion"
      onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !data) void load(); }}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[color:var(--text-primary)]">
        Promotion automatique · état réel (tests, couverture, blocages, candidates, surveillance)
        {h && <span className="ml-2 text-xs text-[color:var(--text-warning-soft)]">• {h.automatic ? 'progrès effectif' : h.code}</span>}
      </summary>
      {!data || !h || !c || !x ? (
        <p className="px-4 pb-4 text-sm text-[color:var(--text-muted)]">Chargement…</p>
      ) : (
        <div className="px-4 pb-4 space-y-3 min-w-0">
          <div className={`rounded-lg border p-2 text-xs space-y-1 break-words ${h.automatic ? TONE.ok : h.code === 'BLOCKED_ACCOUNT' ? TONE.ko : TONE.warn}`} data-testid="auto-promotion-health">
            <p className="font-medium">{h.automatic ? 'Fonctionnement automatique effectif' : 'Pas de fonctionnement automatique effectif'} — {h.label}</p>
            {h.cause && <p>Cause : {h.cause}</p>}
            {h.nextAction && <p><span className="font-medium">Prochain geste : </span>{h.nextAction}</p>}
          </div>

          <section className="space-y-1" aria-label="Planificateur">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(a) Planificateur</h3>
            <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
              {data.scheduler.map((t) => (
                <li key={t.code} className="break-words">
                  {TASK_LABELS[t.code] ?? t.code} : {t.launched ? `lancé le ${formatDateTime(t.lastRunAt!)} (${t.lastStatus ?? '—'})` : 'jamais lancé'}
                  {t.nextRunAt ? ` · prochain passage ${formatDateTime(t.nextRunAt)}` : ''}{t.consecutiveFailures ? ` · ${t.consecutiveFailures} échec(s) consécutif(s)` : ''}
                </li>
              ))}
            </ul>
            <p className="text-xs text-[color:var(--text-muted)]">Une tâche lancée ou « réussie » ne prouve ni un test exécuté ni une amélioration : voir (b) à (e).</p>
          </section>

          <section className="space-y-1" aria-label="Tests réellement exécutés">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(b) Tests réellement exécutés ({x.days} jours)</h3>
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="auto-promotion-executions">
              {x.campaigns} campagne(s) · {x.concludedCases} cas concluant(s) · {x.inconclusiveCases} non concluant(s) · {x.providerCalls} appel(s) fournisseur · coût {(x.costMicros / 1_000_000).toFixed(4)} €
              {x.blockedByPrerequisite ? ` · ${x.blockedByPrerequisite} campagne(s) bloquée(s) par un prérequis` : ''}
              {' '}· compte technique : {x.technicalAccount ? `${x.technicalAccount.code}${x.technicalAccount.ok ? ' (valide)' : ` — ${x.technicalAccount.label}`}` : 'état illisible'}
              {x.lastCampaignAt ? ` · dernière campagne ${formatDateTime(x.lastCampaignAt)}` : ''}.
            </p>
          </section>

          <section className="space-y-1" aria-label="Couverture">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(c) Couverture du corpus et des risques</h3>
            {data.inventory && (
              <p className="text-xs text-[color:var(--text-secondary)] break-words">
                Inventaire attendu {data.inventory.version} (manifeste v{data.inventory.manifestVersion}, {data.inventory.entries} entrée(s), ZIP n° 601 {data.inventory.zipReceived ? 'reçu' : 'NON reçu'}) :{' '}
                {Object.keys(data.inventory.expected).map((k) => `${data.inventory!.counts[k] ?? 0}/${data.inventory!.expected[k]} ${TOTAL_LABELS[k] ?? k}`).join(' · ')}
              </p>
            )}
            <ul className="text-xs text-[color:var(--text-secondary)] space-y-1">
              {data.coverage.map((t) => (
                <li key={t.treatment} className="break-words">
                  <span className="font-medium">{t.treatment}</span> : {t.blockers ? `${t.blockers} manque(s) A1 dont ${t.structural} structurel(s)` : 'aucun manque structurel'} · exigences {t.requirements.met}/{t.requirements.total}
                  {t.byCode.length > 0 && <span className="block text-[color:var(--text-muted)]">{t.byCode.map((b) => `${b.label} ×${b.n}`).join(' · ')}</span>}
                  {t.requirements.waived.map((w) => <span key={w.id} className="block text-[color:var(--text-muted)]">exigence {w.id} exclue : {w.reason}</span>)}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-1" aria-label="Blocages">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(d) Blocages</h3>
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="auto-promotion-blocks">
              Verrou A1 : {data.blocks.a1Candidates} candidate(s) de modèle et {data.blocks.a1PromptIssues} correction(s) de prompt qualifiées métier mais bloquées (pas des refus métier)
              {data.blocks.a1StructuralTreatments.length ? ` · manques structurels sur ${data.blocks.a1StructuralTreatments.join(', ')}` : ''}
              {' '}· compte technique : {data.blocks.account ? `${data.blocks.account.code} — ${data.blocks.account.label}` : 'aucun blocage'}
              {' '}· preuves : {data.blocks.operationsWithEvidence30d} opération(s) mesurée(s) sur 30 jours.
            </p>
          </section>

          <section className="space-y-1" aria-label="Candidates">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">(e) Candidates ({c.days} jours)</h3>
            <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="auto-promotion-candidates">
              {c.created} créée(s) · {c.qualifying} en test · {c.qualified} qualifiée(s) · {c.blockedA1} bloquée(s) A1 · {c.refused} refusée(s) · {c.inconclusive} non concluante(s) · {c.notChosen} non retenue(s)
              {' '}· {c.activated} activée(s) · {c.watching} surveillée(s) · {c.rolledBack} restaurée(s) (retour arrière) · {c.suspended} suspendue(s).
            </p>
          </section>

          {data.events.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">Journal de la promotion ({data.events.length} derniers événements)</summary>
              <ul className="mt-1 text-xs text-[color:var(--text-secondary)] space-y-0.5">
                {data.events.map((e) => <li key={e.id} className="break-words">{formatDateTime(e.createdAt)} · {e.kind}{e.code ? ` (${e.code})` : ''}{e.candidateVersionId ? ` · candidate ${e.candidateVersionId}` : ''}{e.treatment ? ` · ${e.treatment}` : ''} · {e.message}</li>)}
              </ul>
            </details>
          )}

          <div className={`rounded-lg border p-2 text-xs space-y-1 break-words ${TONE.warn}`} data-testid="auto-promotion-deferred">
            <p className="font-medium">Différé (P2) — pas d’« auto-amélioration complète »</p>
            {data.deferred.map((d) => (
              <div key={d.title}>
                <p className="font-medium">{d.title}</p>
                <ul className="list-disc pl-4">{d.needs.map((n) => <li key={n}>{n}</li>)}</ul>
              </div>
            ))}
          </div>
          <p className="text-xs text-[color:var(--text-muted)] break-words">{data.manualFlows.manualActivation} {data.manualFlows.production} Lu le {formatDateTime(data.readAt)} ({data.environment}).</p>
          <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Actualiser
          </Button>
        </div>
      )}
    </details>
  );
}
