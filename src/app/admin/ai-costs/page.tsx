"use client";

/**
 * Admin — Coûts IA — CDC BO IA SCR-09.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN COÛT INCONNU N'EST PAS UN COÛT NUL
 *
 * C'est la règle qui structure tout l'écran. Un appel sans tarif porte zéro
 * dans la table : le sommer sans précaution ferait afficher une dépense
 * rassurante et fausse.
 *
 * Le SCR-09 l'exige — « afficher coût non calculable plutôt qu'un fallback
 * tarifaire silencieux » — et l'écran le montre à trois endroits : un bandeau
 * quand des appels ne sont pas tarifés, une mention sur chaque ventilation
 * concernée, et une moyenne rendue nulle plutôt qu'approchée.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FONCTIONNEL ET TECHNIQUE SÉPARÉS, TOUJOURS
 *
 * Une campagne de sondes pendant une panne coûte, et le MOD-013 la classe en
 * technique. Les additionner ferait chercher une dérive métier là où il n'y a
 * qu'un incident fournisseur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN BOUTON NE COUPE RIEN
 *
 * « Une alerte de coût ne suspend jamais automatiquement un traitement. »
 * L'écran mesure et alerte ; il ne propose aucune action de suspension, qui se
 * fait depuis la file et en connaissance de cause.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, AlertTriangle, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface Breakdown {
  key: string; label: string;
  functionalMicros: number; technicalMicros: number;
  calls: number; unpricedCalls: number;
}

interface Report {
  since: string; until: string;
  totals: {
    functionalMicros: number; technicalMicros: number; calls: number;
    failedCalls: number; inputTokens: number; outputTokens: number; unpricedCalls: number;
  };
  byTreatment: Breakdown[];
  byModel: Breakdown[];
  byRank: Breakdown[];
  byVersion: Breakdown[];
  incomplete: boolean;
  averageCostPerCall: number | null;
  warning: string | null;
}

const PERIODS = [
  { key: 'today', label: "Aujourd'hui" },
  { key: '7d', label: '7 jours' },
  { key: '30d', label: '30 jours' },
  { key: 'year', label: 'Année' },
];

function usd(micros: number): string {
  if (micros === 0) return '0 $';
  if (micros < 10_000) return `${(micros / 1_000_000).toFixed(4)} $`;
  return `${(micros / 1_000_000).toFixed(2)} $`;
}

function Ventilation({ title, rows, hint }: { title: string; rows: Breakdown[]; hint?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.functionalMicros + r.technicalMicros));
  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h2>
        {hint && <p className="text-xs text-[color:var(--text-muted)]">{hint}</p>}
      </div>
      {rows.length === 0 && (
        <p className="text-sm text-[color:var(--text-muted)]">Aucune dépense sur la période.</p>
      )}
      {rows.map((r) => {
        const total = r.functionalMicros + r.technicalMicros;
        return (
          <div key={r.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-[color:var(--text-primary)] truncate">{r.label}</span>
              <span className="text-sm text-[color:var(--text-secondary)] shrink-0">{usd(total)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-[color:var(--bg-page)] overflow-hidden">
              <div className="h-full bg-[color:var(--accent)]"
                style={{ width: `${Math.round((total / max) * 100)}%` }} />
            </div>
            <p className="text-xs text-[color:var(--text-muted)]">
              {r.calls} appel{r.calls > 1 ? 's' : ''}
              {r.technicalMicros > 0 && ` · dont ${usd(r.technicalMicros)} technique`}
              {r.unpricedCalls > 0 && (
                <span className="text-amber-500"> · {r.unpricedCalls} sans tarif</span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function AiCostsPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [period, setPeriod] = useState('30d');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await apiClient.get<Report>(`/api/admin/ai/costs?period=${period}`));
    } catch {
      toast.error('Chargement impossible. Réessayez dans un instant.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (loading || !report) {
    return (
      <div className="flex items-center justify-center py-20 text-[color:var(--text-muted)]">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Chargement…
      </div>
    );
  }

  const t = report.totals;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--text-primary)]">Coûts IA</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Du {new Date(report.since).toLocaleDateString('fr-FR')} au{' '}
            {new Date(report.until).toLocaleDateString('fr-FR')}.
          </p>
        </div>
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <Button key={p.key} size="sm" variant={period === p.key ? 'default' : 'outline'}
              onClick={() => setPeriod(p.key)}>
              {p.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={load}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {report.warning && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-[color:var(--text-primary)]">{report.warning}</p>
            <p className="text-xs text-[color:var(--text-muted)]">
              Le coût de ces appels n&apos;est pas estimé : il serait faux. Rafraîchissez la
              grille tarifaire depuis l&apos;écran Fournisseur IA.
            </p>
          </div>
        </div>
      )}

      {/* Synthèse — fonctionnel et technique séparés */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
          <p className="text-sm text-[color:var(--text-muted)]">Dépense métier</p>
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">
            {usd(t.functionalMicros)}
          </p>
        </div>
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
          <p className="text-sm text-[color:var(--text-muted)]">Technique et tests</p>
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">
            {usd(t.technicalMicros)}
          </p>
          <p className="text-xs text-[color:var(--text-muted)]">Sondes, observation, vérifications</p>
        </div>
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
          <p className="text-sm text-[color:var(--text-muted)]">Appels</p>
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">{t.calls}</p>
          <p className="text-xs text-[color:var(--text-muted)]">
            {t.failedCalls} en échec · {(t.inputTokens + t.outputTokens).toLocaleString('fr-FR')} tokens
          </p>
        </div>
        <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4">
          <p className="text-sm text-[color:var(--text-muted)]">Coût moyen par appel</p>
          <p className="text-2xl font-bold text-[color:var(--text-primary)]">
            {report.averageCostPerCall === null ? '—' : usd(report.averageCostPerCall)}
          </p>
          {report.averageCostPerCall === null && (
            <p className="text-xs text-amber-500">Aucun appel tarifé sur la période</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Ventilation title="Par traitement" rows={report.byTreatment} />
        <Ventilation title="Par modèle" rows={report.byModel} />
        <Ventilation
          title="Par rang de modèle"
          rows={report.byRank}
          hint="Une dépense de repli importante signale un modèle principal en difficulté."
        />
        <Ventilation
          title="Par version de configuration"
          rows={report.byVersion}
          hint="Les coûts ne sont jamais recalculés : un changement de tarif ne réécrit pas le passé."
        />
      </div>

      <a href="/admin/ai-executions"
        className="inline-flex items-center gap-1.5 text-sm text-[color:var(--accent)] hover:underline">
        Voir les appels correspondants <ArrowRight className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}
