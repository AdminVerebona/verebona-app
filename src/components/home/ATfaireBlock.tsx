"use client"

import Link from 'next/link';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import type { HomeItem } from '@/services/home/HomeSummaryService';

interface Props {
  items: HomeItem[];
  total: number;
  onItemClick?: (item: HomeItem) => void;
}

// Dot color par raison
const DOT_COLORS: Record<string, string> = {
  missing_asset:            'bg-amber-400',
  overdue_action:           'bg-red-500',
  missing_date:             'bg-amber-400',
  validation_required:      'bg-violet-400',
  coherence_alert:          'bg-orange-500',
  // Raisons V2 (À traiter)
  date_conflict:            'bg-orange-500',
  document_type_to_confirm: 'bg-violet-400',
  missing_required_label:   'bg-amber-400',
  asset_suggestion_to_confirm: 'bg-violet-400',
  supplier_to_confirm:      'bg-violet-400',
  supplier_conflict:        'bg-orange-500',
  data_inconsistency:       'bg-orange-500',
};

// Couleur du sous-label par raison
const SUBLABEL_COLORS: Record<string, string> = {
  missing_asset:            'text-amber-400',
  overdue_action:           'text-red-400',
  missing_date:             'text-amber-400',
  validation_required:      'text-violet-400',
  coherence_alert:          'text-orange-400',
  // Raisons V2 (À traiter)
  date_conflict:            'text-orange-400',
  document_type_to_confirm: 'text-violet-400',
  missing_required_label:   'text-amber-400',
  asset_suggestion_to_confirm: 'text-violet-400',
  supplier_to_confirm:      'text-violet-400',
  supplier_conflict:        'text-orange-400',
  data_inconsistency:       'text-orange-400',
};

// Libellé d'action par raison
const ACTION_COLORS: Record<string, string> = {
  missing_asset:            'text-[#6366f1] hover:text-[#818cf8]',
  overdue_action:           'text-[#6366f1] hover:text-[#818cf8]',
  missing_date:             'text-[#6366f1] hover:text-[#818cf8]',
  validation_required:      'text-[#6366f1] hover:text-[#818cf8]',
  coherence_alert:          'text-[#6366f1] hover:text-[#818cf8]',
  date_conflict:            'text-[#6366f1] hover:text-[#818cf8]',
  document_type_to_confirm: 'text-[#6366f1] hover:text-[#818cf8]',
  missing_required_label:   'text-[#6366f1] hover:text-[#818cf8]',
  asset_suggestion_to_confirm: 'text-[#6366f1] hover:text-[#818cf8]',
  supplier_to_confirm:      'text-[#6366f1] hover:text-[#818cf8]',
  supplier_conflict:        'text-[#6366f1] hover:text-[#818cf8]',
  data_inconsistency:       'text-[#6366f1] hover:text-[#818cf8]',
};

export function ATfaireBlock({ items, total, onItemClick }: Props) {
  return (
    <div className="w-full max-w-2xl">

      {items.length === 0 ? (
        <div className="flex items-start gap-4 bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl px-5 py-4">
          <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <CheckCircle2 className="w-[18px] h-[18px] text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">
              Aucune action requise.
            </p>
            <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
              Cette section affichera les éléments à finaliser quand il y en aura.
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl overflow-hidden">
          {items.map((item, idx) => {
            const dotColor = DOT_COLORS[item.reason ?? ''] ?? 'bg-slate-400';
            const subLabelColor = SUBLABEL_COLORS[item.reason ?? ''] ?? 'text-slate-400';
            const actionColor = ACTION_COLORS[item.reason ?? ''] ?? 'text-[#6366f1] hover:text-[#818cf8]';

            return (
              <div key={item.id}>
                {idx > 0 && (
                  <div className="h-px bg-[color:var(--border-subtle)] mx-4" />
                )}
                <button
                  onClick={() => onItemClick?.(item)}
                  className="w-full flex items-center gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.02] group"
                >
                  {/* Dot coloré */}
                  <div className="flex-shrink-0 flex items-center justify-center w-5">
                    <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                  </div>

                  {/* Contenu principal */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)] truncate leading-snug">
                      {item.title}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {item.subLabel && (
                        <span className={`text-xs font-medium ${subLabelColor}`}>
                          {item.subLabel}
                        </span>
                      )}
                      {item.context && (
                        <>
                          {item.subLabel && (
                            <span className="text-xs text-[color:var(--text-muted)]">·</span>
                          )}
                          <span className="text-xs text-[color:var(--text-muted)] truncate">
                            {item.context}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Action contextuelle */}
                  {item.primaryAction && (
                    <div className={`flex-shrink-0 flex items-center gap-0.5 text-xs font-semibold transition-colors ${actionColor}`}>
                      <span>{item.primaryAction}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </div>
                  )}
                </button>
              </div>
            );
          })}

          {/* Lien "Voir tout dans À traiter" si > 5 */}
          {total > 5 && (
            <>
              <div className="h-px bg-[color:var(--border-subtle)] mx-4" />
              <Link
                href="/a-traiter"
                className="flex items-center justify-between px-5 py-3 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors group"
              >
                <span>
                  Voir les <span className="font-semibold text-[color:var(--text-primary)]">{total - 5}</span> autres éléments dans À traiter
                </span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
