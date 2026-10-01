'use client';
/**
 * Questions d'aide sans réponse — CDC §10.4.
 *
 * Liste simple, par fréquence : ce que les utilisateurs demandent à
 * l'assistant et que la base d'aide ne couvre pas. Texte expurgé côté
 * serveur ; ni compte ni utilisateur affichés.
 */
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

interface Question { intent: string; question: string; count: number; lastSeen: string }
/** §32.5 : demandes non résolues par motif et intention (compteurs seulement). */
interface Motifs {
  total: number;
  byMotive: Array<{ motive: string; label: string; count: number }>;
  byIntent: Array<{ intent: string; motive: string; label: string; count: number }>;
}

const INTENT_LABEL: Record<string, string> = {
  PRODUCT_HELP_HOW_TO: 'Comment faire',
  PRODUCT_HELP_EXPLAIN: 'À quoi sert',
  PRODUCT_HELP_STATUS: 'Statut',
  NAVIGATION_FIND: 'Où trouver',
  EXPORT_HELP: 'Export',
};

export function UnansweredHelpQuestions() {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [motifs, setMotifs] = useState<Motifs | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let annule = false;
    apiClient.get<{ questions: Question[]; motifs?: Motifs | null }>('/api/admin/ai/t2-unanswered?days=30')
      .then((r) => { if (!annule) { setQuestions(r.questions ?? []); setMotifs(r.motifs ?? null); } })
      .catch(() => { if (!annule) setErreur(true); });
    return () => { annule = true; };
  }, []);

  return (
    <section className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-2" aria-label="Questions sans réponse">
      {/* §32.5 : toutes les demandes non résolues, par motif puis par
          intention — compteurs seulement, aucun texte. */}
      {motifs && (
        <div className="space-y-2" data-testid="unanswered-motives">
          <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">
            Demandes non résolues par motif (30 derniers jours) · {motifs.total}
          </h2>
          <div className="flex flex-wrap gap-2">
            {motifs.byMotive.map((m) => (
              <span key={m.motive} className="text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)]">
                {m.label} <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{m.count}</span>
              </span>
            ))}
          </div>
          {motifs.byIntent.length > 0 && (
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {motifs.byIntent.map((g) => (
                <li key={`${g.intent}|${g.motive}`} className="py-1 text-sm flex items-baseline gap-2">
                  <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{g.count}×</span>
                  <span className="text-xs rounded border border-[color:var(--border-subtle)] px-1.5 text-[color:var(--text-muted)]">
                    {INTENT_LABEL[g.intent] ?? g.intent}
                  </span>
                  <span className="flex-1 text-[color:var(--text-secondary)]">{g.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">Questions d’aide sans réponse (30 derniers jours)</h2>
      <p className="text-xs text-[color:var(--text-muted)]">
        Demandes d’aide pour lesquelles aucun article du Centre d’aide n’a été trouvé. Texte expurgé.
      </p>
      {erreur && <p className="text-sm text-[color:var(--text-muted)]">Liste indisponible pour le moment.</p>}
      {!erreur && questions === null && <p className="text-sm text-[color:var(--text-muted)]">Chargement…</p>}
      {!erreur && questions?.length === 0 && <p className="text-sm text-[color:var(--text-muted)]">Aucune question sans réponse.</p>}
      {!erreur && questions && questions.length > 0 && (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {questions.map((q, i) => (
            <li key={i} className="py-1.5 text-sm flex items-baseline gap-2">
              <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{q.count}×</span>
              <span className="text-xs rounded border border-[color:var(--border-subtle)] px-1.5 text-[color:var(--text-muted)]">
                {INTENT_LABEL[q.intent] ?? q.intent}
              </span>
              <span className="flex-1 text-[color:var(--text-secondary)]">{q.question}</span>
              <span className="text-xs text-[color:var(--text-muted)]">{new Date(q.lastSeen).toLocaleDateString('fr-FR')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
