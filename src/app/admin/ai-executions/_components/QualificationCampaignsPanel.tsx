'use client';

/**
 * Exécutions & logs › vue technique › Qualification — lot 86A (CDC Pilotage
 * IA V2 P5 : QUAL-01, R06, R13, BO-02, BO-08 ; décision PO n° 13).
 *
 * Campagnes de qualification par couple (tests manuels du BO, campagnes
 * automatiques de préproduction) : ce sont des exécutions TECHNIQUES, jamais
 * comptées dans les cartes métier. Pour chaque campagne : point de
 * restauration, état (refus motivé, interruption), puis pour chaque couple le
 * verdict et ses motifs par étape (intégrité, technique, qualité, délai,
 * concurrence), les métriques et chaque cas — source de la vérité attendue,
 * défauts par catégorie, motif « non concluant », comparaison à l'historique
 * (empreintes, jamais le contenu), durée, modèle réellement servi.
 * Desktop et mobile : cartes empilées, détail déplié sur place.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/admin/format';
import { Button } from '@/components/ui/button';

interface CampaignItem { id: number; kind: string; status: string; createdAt: string; finishedAt: string | null; restorePointId: string | null; refusal: string | null; error: string | null; couples: number | null; activatedVersionId: number | null }
interface Reason { step: string; outcome: string; code: string; message: string }
interface CaseRec {
  caseId: string; source: string; expectedSource: string; advisory: boolean; observation: number; outcome: string;
  defects: Array<{ category: string; message: string }>; inconclusiveReason: string | null; matchesHistorical: boolean | null;
  durationMs: number | null; timeoutMs: number | null; servedModel: string | null; accountId: number | null; captureId: number | null;
}
interface Evidence {
  id: number; operationCode: string; model: string; servedModel: string | null; rank: number; role: string; verdict: string; reasons: Reason[];
  metrics: { cases?: { total: number; validatedMandatory: number; mandatory: number }; latency?: { p95Ms: number | null; referenceP95Ms: number | null }; skipped?: { count: number; reasons: string[] } };
  signature: string; createdAt: string; cases: CaseRec[];
}
interface Detail { campaign: CampaignItem & { request: Record<string, unknown>; summary: Record<string, unknown>; restorePointAt: string | null }; evidence: Evidence[] }

const STATUT: Record<string, string> = { PENDING: 'en attente', RUNNING: 'en cours', COMPLETED: 'terminée', REFUSED: 'refusée', INTERRUPTED: 'interrompue', FAILED: 'en échec' };
const VERDICT: Record<string, string> = { ADMISSIBLE: 'Admissible', REFUSED: 'Refusée', INCONCLUSIVE: 'Non concluante' };
const ETAPE: Record<string, string> = { INTEGRITY: 'Intégrité', TECHNICAL: 'Technique', QUALITY: 'Qualité', LATENCY: 'Délai', CONCURRENCY: 'Concurrence' };
const SOURCE: Record<string, string> = { CORPUS_FIXTURE: 'corpus', T1_REFERENCE: 'référence T1 (consultatif)', PREPROD_REPLAY: 'rejeu préprod' };
const ISSUE: Record<string, string> = { PASSED: 'réussi', FAILED: 'échoué', INCONCLUSIVE: 'non concluant' };

export function QualificationCampaignsPanel() {
  const [items, setItems] = useState<CampaignItem[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ campaigns: CampaignItem[] }>('/api/admin/ai/qualification');
      setItems(r.campaigns);
    } catch {
      toast.error('Campagnes de qualification indisponibles.');
      setItems([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ouvrir = async (id: number) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setDetail(null);
    try {
      setDetail(await apiClient.get<Detail>(`/api/admin/ai/qualification/campaigns/${id}`));
    } catch {
      toast.error('Détail indisponible.');
    }
  };

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3 min-w-0" data-testid="qualification-campaigns">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <p className="flex-1 min-w-0 text-xs text-[color:var(--text-muted)]">
          Campagnes techniques : point de restauration avant tout appel, rejeu sans écriture métier, aucun effet externe. Tests manuels : Configuration IA › Qualification par couple.
        </p>
        <Button size="sm" variant="outline" className="min-h-[44px] sm:min-h-0" onClick={() => void load()}>Actualiser</Button>
      </div>
      {items === null && <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>}
      {items?.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune campagne de qualification.</p>}
      {items?.map((c) => (
        <div key={c.id} className="rounded-lg border border-[color:var(--border-subtle)] min-w-0">
          <button type="button" className="w-full text-left px-3 py-2 min-h-[44px] text-sm break-words" onClick={() => void ouvrir(c.id)} aria-expanded={open === c.id}>
            <span className="font-medium text-[color:var(--text-primary)]">Campagne n° {c.id}</span>
            <span className="text-[color:var(--text-secondary)]"> · {c.kind === 'AUTO' ? 'automatique' : 'test manuel'} · {STATUT[c.status] ?? c.status} · {formatDateTime(c.createdAt)}</span>
            {c.refusal && <span className="block text-xs text-[color:var(--text-warning)]">{c.refusal}</span>}
            {c.error && <span className="block text-xs text-[color:var(--text-danger)]">{c.error}</span>}
          </button>
          {open === c.id && (
            <div className="px-3 pb-3 space-y-3">
              {!detail ? <p className="text-xs text-[color:var(--text-muted)]">Chargement…</p> : (
                <>
                  <p className="text-xs text-[color:var(--text-secondary)] break-words">
                    Point de restauration : {detail.campaign.restorePointId ? `${detail.campaign.restorePointId} (${formatDateTime(detail.campaign.restorePointAt)})` : 'aucun'}
                    {detail.campaign.activatedVersionId ? ` · candidate v${detail.campaign.activatedVersionId} activée en préproduction` : ''}
                  </p>
                  {detail.evidence.length === 0 && <p className="text-xs text-[color:var(--text-muted)]">Aucune preuve enregistrée.</p>}
                  {detail.evidence.map((e) => (
                    <div key={e.id} className="rounded-lg border border-[color:var(--border-subtle)] p-2 space-y-1.5 min-w-0" data-testid="qualification-evidence">
                      <p className="text-sm text-[color:var(--text-primary)] break-words">
                        {VERDICT[e.verdict] ?? e.verdict} · {e.operationCode} · rang {e.rank} · {e.model}{e.servedModel && e.servedModel !== e.model ? ` (servi : ${e.servedModel})` : ''} · {e.role === 'REFERENCE' ? 'référence' : 'candidat'}
                      </p>
                      <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
                        {e.reasons.filter((r) => r.outcome !== 'OK').concat(e.reasons.every((r) => r.outcome === 'OK') ? e.reasons : []).map((r, i) => (
                          <li key={i} className="break-words">{ETAPE[r.step] ?? r.step} — {r.outcome === 'BLOCKING' ? 'bloquant' : r.outcome === 'INCONCLUSIVE' ? 'non concluant' : 'ok'} : {r.message}</li>
                        ))}
                      </ul>
                      <p className="text-xs text-[color:var(--text-muted)] break-words">
                        {e.metrics.cases ? `${e.metrics.cases.validatedMandatory}/${e.metrics.cases.mandatory} cas obligatoires validés` : ''}
                        {e.metrics.latency?.p95Ms != null ? ` · P95 ${e.metrics.latency.p95Ms} ms${e.metrics.latency.referenceP95Ms != null ? ` (référence ${e.metrics.latency.referenceP95Ms} ms)` : ''}` : ''}
                        {e.metrics.skipped?.count ? ` · ${e.metrics.skipped.count} cas écarté(s) : ${e.metrics.skipped.reasons.join(' ; ')}` : ''}
                      </p>
                      <details>
                        <summary className="cursor-pointer text-xs text-[color:var(--text-secondary)]">{e.cases.length} résultat(s) de cas</summary>
                        <div className="mt-1 space-y-1">
                          {e.cases.map((k, i) => (
                            <p key={i} className="text-xs text-[color:var(--text-secondary)] break-words">
                              {k.caseId} #{k.observation} · {SOURCE[k.source] ?? k.source} · {ISSUE[k.outcome] ?? k.outcome}
                              {k.durationMs != null ? ` · ${k.durationMs} ms` : ''}{k.servedModel ? ` · ${k.servedModel}` : ''}
                              {k.matchesHistorical != null ? ` · ${k.matchesHistorical ? 'identique' : 'différent'} de l’historique` : ''}
                              {k.defects.length ? ` — ${k.defects.map((d) => `${d.category} : ${d.message}`).join(' ; ')}` : ''}
                              {k.inconclusiveReason ? ` — ${k.inconclusiveReason}` : ''}
                            </p>
                          ))}
                        </div>
                      </details>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
