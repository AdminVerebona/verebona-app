'use client';

/**
 * Zone de supervision — CDC BO IA SCR-02 à SCR-06, et observabilité §18
 * (CDC 15, lot 17) dans le tableau de bord IA.
 *
 * ⚠️ Un indicateur non mesuré affiche « pas encore mesuré », jamais zéro. Un
 * zéro serait lu comme une absence de problème, ce qui est exactement le
 * contraire de ce qu'on sait — c'est la même règle que sur l'écran Coûts.
 *
 * La raison est affichée avec l'indicateur : elle dit ce qu'il faudrait
 * instrumenter, et évite qu'on redécouvre chaque fois pourquoi la case est vide.
 *
 * Extrait tel quel de la page Configuration IA pour être réutilisé par le
 * tableau de bord (même rendu : « garde mon design ») ; les options
 * ajoutées (titre, fenêtre masquable, lien, notes) gardent le rendu
 * d'origine par défaut.
 */

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit?: 'count' | 'percent' | 'ms' | 'usd_micros' | 'decimal';
  missingReason?: string;
}

export interface MetricTable {
  key: string;
  label: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
}

export function formatMetric(m: Metric): string {
  if (m.value === null) return '—';
  if (m.unit === 'percent') return `${m.value} %`;
  if (m.unit === 'usd_micros') {
    if (m.value === 0) return '0 $';
    return m.value < 10_000 ? `${(m.value / 1_000_000).toFixed(4)} $` : `${(m.value / 1_000_000).toFixed(2)} $`;
  }
  if (m.unit === 'decimal') return m.value.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  if (m.unit === 'ms') return m.value >= 1000 ? `${(m.value / 1000).toFixed(1)} s` : `${m.value} ms`;
  return m.value.toLocaleString('fr-FR');
}

export function Supervision({
  treatment, metrics, tables, windowDays, onWindowChange,
  title = 'Supervision', showWindow = true, href, notes,
}: {
  treatment: string;
  metrics: Metric[];
  tables?: MetricTable[];
  windowDays: number;
  onWindowChange?: (d: number) => void;
  title?: string;
  /** Sélecteur 24 h / 7 j / 30 j (masqué quand la page porte déjà le sien). */
  showWindow?: boolean;
  /** Lien « Voir les appels » ; `null` le masque. Défaut : exécutions du traitement. */
  href?: string | null;
  notes?: string[];
}) {
  const lien = href === undefined
    ? `/admin/ai-executions?${new URLSearchParams({
      treatment,
      from: new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10),
    })}`
    : href;

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</h3>
        {/*
          Fenêtre réglable plutôt que compteurs remis à zéro. Ces indicateurs
          comptent des traces réelles : les effacer pour assainir l'écran
          reviendrait à supprimer la preuve de ce qui s'est passé. Regarder de
          plus près suffit, et n'altère rien.
        */}
        {showWindow && onWindowChange && (
          <div className="flex gap-1">
            {[
              { d: 1, label: '24 h' },
              { d: 7, label: '7 j' },
              { d: 30, label: '30 j' },
            ].map((f) => (
              <button
                key={f.d}
                onClick={() => onWindowChange(f.d)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  windowDays === f.d
                    ? 'border-[color:var(--accent)] text-[color:var(--accent)] bg-[color:var(--accent-soft)]'
                    : 'border-[color:var(--border-subtle)] text-[color:var(--text-muted)]'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.key} className="space-y-0.5">
            <p className="text-xs text-[color:var(--text-muted)]">{m.label}</p>
            <p className={`text-lg font-semibold ${m.value === null
              ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-primary)]'}`}>
              {formatMetric(m)}
            </p>
            {m.value === null && m.missingReason && (
              <p className="text-xs text-amber-500 leading-snug">{m.missingReason}</p>
            )}
          </div>
        ))}
      </div>

      {tables?.map((t) => (
        <div key={t.key} className="space-y-1.5">
          <p className="text-xs font-medium text-[color:var(--text-primary)]">{t.label}</p>
          {t.rows.length === 0 ? (
            <p className="text-xs text-[color:var(--text-muted)]">Aucun élément sur la période.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[color:var(--text-muted)]">
                    {t.columns.map((c) => <th key={c.key} className="py-1 pr-3 font-medium">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => (
                    <tr key={i} className="border-t border-[color:var(--border-subtle)]">
                      {t.columns.map((c) => (
                        <td key={c.key} className="py-1 pr-3 text-[color:var(--text-primary)]">
                          {c.key === 'date' && r[c.key] ? new Date(String(r[c.key])).toLocaleString('fr-FR') : (r[c.key] ?? '—')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {(notes?.length ?? 0) > 0 && (
        <div className="space-y-0.5">
          {notes!.map((n, i) => (
            <p key={i} className="text-xs text-[color:var(--text-muted)] leading-snug">{n}</p>
          ))}
        </div>
      )}

      {/* Lien préfiltré sur ce traitement et sa fenêtre (CDC Mascotte BO-002, COST-009). */}
      {lien && (
        <a href={lien} className="inline-block text-xs text-[color:var(--accent)] hover:underline">
          Voir les appels correspondants
        </a>
      )}
    </div>
  );
}
