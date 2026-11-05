'use client';
/**
 * Journal « Questions sans réponse » — lot 110E (supervision IA, onglet
 * « Requêtes T2 »).
 *
 * Fondé sur les traces T2 existantes (aucun journal concurrent) : groupes de
 * questions proches (texte expurgé côté serveur), nombre d'occurrences,
 * motifs distincts, statut de revue À analyser / À corriger / Résolu, détail
 * de diagnostic (corpus et version, sections examinées et scores, sélection,
 * environnement, révision) et lien vers la trace (sources sans contenu ; le
 * contenu reste derrière l'accès restreint existant). Couverture effective du
 * catalogue des questions Ressources en tête. Charte Sérénité : jetons seulement.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

interface Occurrence {
  requestId: string; at: string; intent: string | null; origin: 'FREE' | 'SUGGESTION'; suggestionId: string | null;
  corpus: string; corpusVersion: string | null; environment: string | null; appRevision: string | null;
  motive: string; qualityAlerts: string[]; fallbackReason: string | null;
  examined: Array<{ articleId: string; anchor: string; score: number; kept: boolean; reason?: string }>;
  selected: { articleId: string; anchors: string[] } | null; evidenceStatus: string | null; missingSubjects: string[];
}
interface Group {
  groupKey: string; question: string | null; count: number; firstSeen: string; lastSeen: string;
  motives: Array<{ motive: string; label: string; count: number }>; corpora: string[]; origins: string[]; suggestionIds: string[];
  status: 'TO_ANALYZE' | 'TO_FIX' | 'RESOLVED'; statusLabel: string; note: string | null; reopened: boolean; occurrences: Occurrence[];
}
interface CatalogRow {
  id: string; label: string; articleId: string | null; revision: number | null; validatedRevision: number | null; revisionChanged: boolean;
  status: string; proposed: boolean; missingSections: string[]; missingSubjects: string[];
}
interface Journal {
  days: number; retentionDays: number; occurrences: number; groups: Group[];
  totals: Array<{ motive: string; label: string; count: number }>; catalog: CatalogRow[] | null;
  labels: { motives: Record<string, string>; hints: Record<string, string>; statuses: Record<string, string> };
}
interface TraceSource { sourceType: string; sourceId: string; title: string | null; rank: number | null; relevanceScore: number | null }

const ORIGINES: Record<string, string> = { FREE: 'Question libre', SUGGESTION: 'Suggestion' };
const CORPUS: Record<string, string> = { ACCOUNT: 'Données du compte', HELP: 'Centre d’aide', RESOURCES: 'Ressources' };
const sel = 'h-8 rounded border border-[color:var(--input)] bg-[color:var(--bg-input)] px-2 text-sm text-[color:var(--text-primary)]';
const puce = 'text-xs rounded border border-[color:var(--border-subtle)] px-1.5 py-0.5 text-[color:var(--text-secondary)]';
const date = (s: string) => new Date(s).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function T2UnansweredJournal() {
  const [f, setF] = useState({ days: '30', origin: '', corpus: '', motive: '', status: '' });
  const [j, setJ] = useState<Journal | null>(null);
  const [erreur, setErreur] = useState(false);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceSource[] | 'loading' | 'error'>>({});

  const charger = useCallback(async () => {
    setErreur(false);
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    try { setJ(await apiClient.get<Journal>(`/api/admin/ai/t2-unanswered/journal?${q}`)); } catch { setErreur(true); }
  }, [f]);
  useEffect(() => { void charger(); }, [charger]);

  const statut = async (g: Group, status: Group['status']) => {
    try {
      await apiClient.patch('/api/admin/ai/t2-unanswered/journal', { groupKey: g.groupKey, status, note: g.note });
      await charger();
    } catch { setErreur(true); }
  };
  const voirTrace = async (requestId: string) => {
    setTraces((t) => ({ ...t, [requestId]: 'loading' }));
    try {
      const r = await apiClient.get<{ sources: TraceSource[] }>(`/api/admin/ai/t2-requests/${encodeURIComponent(requestId)}`);
      setTraces((t) => ({ ...t, [requestId]: r.sources ?? [] }));
    } catch { setTraces((t) => ({ ...t, [requestId]: 'error' })); }
  };

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-3" aria-label="Journal des questions sans réponse" data-testid="t2-unanswered-journal">
      <h2 className="vb-app-section">Questions sans réponse — journal</h2>
      <p className="text-xs text-[color:var(--text-muted)]">
        Fondé sur les traces de l’assistant. Questions expurgées, sans compte ni utilisateur. Conservation : {j?.retentionDays ?? '…'} jours (durée de l’historique).
      </p>

      <div className="flex flex-wrap gap-2 items-center">
        <select aria-label="Période" className={sel} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}>
          {['7', '30', '90'].map((d) => <option key={d} value={d}>{d} jours</option>)}
        </select>
        <select aria-label="Origine" className={sel} value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })}>
          <option value="">Toutes origines</option>
          {Object.entries(ORIGINES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Corpus" className={sel} value={f.corpus} onChange={(e) => setF({ ...f, corpus: e.target.value })}>
          <option value="">Tous corpus</option>
          {Object.entries(CORPUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Motif" className={sel} value={f.motive} onChange={(e) => setF({ ...f, motive: e.target.value })}>
          <option value="">Tous motifs</option>
          {Object.entries(j?.labels.motives ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Statut" className={sel} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Tous statuts</option>
          {Object.entries(j?.labels.statuses ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <Button size="sm" variant="outline" onClick={() => void charger()}>Actualiser</Button>
      </div>

      {erreur && <p className="text-sm text-[color:var(--text-muted)]">Journal indisponible pour le moment.</p>}
      {!erreur && !j && <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>}

      {j && (
        <>
          <div className="flex flex-wrap gap-2" data-testid="journal-totals">
            {j.totals.map((t) => (
              <span key={t.motive} className={puce} title={j.labels.hints[t.motive]}>
                {t.label} <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{t.count}</span>
              </span>
            ))}
          </div>

          {j.catalog && (
            <details className="text-sm" data-testid="journal-catalog">
              <summary className="cursor-pointer text-[color:var(--text-secondary)]">
                Couverture des questions Ressources proposées · {j.catalog.filter((c) => c.proposed).length}/{j.catalog.length} couvertes
              </summary>
              <ul className="divide-y divide-[color:var(--border-subtle)] mt-1">
                {j.catalog.map((c) => (
                  <li key={c.id} className="py-1 flex flex-wrap gap-2 items-baseline">
                    <span className={puce}>{c.proposed ? 'Couverte' : 'Retirée'}</span>
                    <span className="text-[color:var(--text-primary)]">{c.label}</span>
                    <span className="text-xs text-[color:var(--text-muted)]">
                      {c.articleId ?? '—'} · révision {c.revision ?? '?'}{c.revisionChanged ? ` (validée : ${c.validatedRevision})` : ''} · {c.status}
                      {c.missingSubjects.length > 0 && ` · manque : ${c.missingSubjects.join(', ')}`}
                      {c.missingSections.length > 0 && ` · sections absentes : ${c.missingSections.join(', ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {j.groups.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune question sans réponse sur la période.</p>}
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {j.groups.map((g) => (
              <li key={g.groupKey} className="py-2 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{g.count}×</span>
                  <span className="flex-1 min-w-[12rem] break-words text-[color:var(--text-primary)]">
                    {g.question ?? <span className="text-[color:var(--text-muted)]">Question non conservée{g.suggestionIds.length ? ` (suggestion ${g.suggestionIds.join(', ')})` : ''}</span>}
                  </span>
                  {g.reopened && <span className={puce}>Réapparue après « Résolu »</span>}
                  <select aria-label="Statut de revue" className={sel} value={g.status} onChange={(e) => void statut(g, e.target.value as Group['status'])}>
                    {Object.entries(j.labels.statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <Button size="sm" variant="ghost" onClick={() => setOuvert(ouvert === g.groupKey ? null : g.groupKey)}>
                    {ouvert === g.groupKey ? 'Masquer' : 'Détail'}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {g.motives.map((m) => <span key={m.motive} className={puce} title={j.labels.hints[m.motive]}>{m.label} · {m.count}</span>)}
                  {g.corpora.map((c) => <span key={c} className={puce}>{CORPUS[c] ?? c}</span>)}
                  {g.origins.map((o) => <span key={o} className={puce}>{ORIGINES[o] ?? o}</span>)}
                  <span className="text-[color:var(--text-muted)]">dernière : {date(g.lastSeen)}</span>
                </div>
                {ouvert === g.groupKey && (
                  <ul className="mt-1 space-y-2 border-l border-[color:var(--border-subtle)] pl-3">
                    {g.occurrences.map((o) => {
                      const t = traces[o.requestId];
                      return (
                        <li key={o.requestId} className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
                          <div>
                            {date(o.at)} · {ORIGINES[o.origin]}{o.suggestionId ? ` ${o.suggestionId}` : ''} · {o.intent ?? '—'} · {CORPUS[o.corpus] ?? o.corpus}
                            {o.corpusVersion ? ` ${o.corpusVersion}` : ''} · {j.labels.motives[o.motive] ?? o.motive}
                            {o.fallbackReason ? ` (${o.fallbackReason})` : ''}
                          </div>
                          {o.evidenceStatus && <div>Preuve de la suggestion : {o.evidenceStatus}{o.missingSubjects.length ? ` — manque : ${o.missingSubjects.join(', ')}` : ''}</div>}
                          {o.qualityAlerts.length > 0 && <div>Alertes qualité : {o.qualityAlerts.join(', ')}</div>}
                          {o.selected && <div>Retenu : {o.selected.articleId}{o.selected.anchors.length ? ` #${o.selected.anchors.join(', #')}` : ''}</div>}
                          {o.examined.length > 0 && (
                            <div className="break-words">
                              Examinés : {o.examined.map((x) => `${x.articleId}#${x.anchor} ${x.score.toFixed(2)}${x.kept ? '' : ` écarté (${x.reason})`}`).join(' · ')}
                            </div>
                          )}
                          <div>Environnement : {o.environment ?? '—'} · révision : {o.appRevision ?? '—'} · demande {o.requestId}</div>
                          <Button size="sm" variant="outline" onClick={() => void voirTrace(o.requestId)}>Voir la trace</Button>
                          {t === 'loading' && <span className="ml-2">Chargement…</span>}
                          {t === 'error' && <span className="ml-2">Trace indisponible.</span>}
                          {Array.isArray(t) && (
                            <ul className="ml-2">
                              {t.length === 0 && <li>Aucune source citée.</li>}
                              {t.map((s) => <li key={`${s.sourceType}:${s.sourceId}`}>{s.rank ?? '–'}. {s.sourceType} {s.sourceId} {s.title ?? ''} {s.relevanceScore != null ? `(${s.relevanceScore.toFixed(2)})` : ''}</li>)}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
