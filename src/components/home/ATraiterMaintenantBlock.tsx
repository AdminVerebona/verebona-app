"use client"

import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import type { HomeItem } from '@/services/home/HomeSummaryService';

interface Props {
  items: HomeItem[];
  total: number;
  onItemClick?: (item: HomeItem) => void;
}

function reasonLabel(item: HomeItem): string {
  switch (item.reason) {
    case 'missing_asset':
      return `« ${item.title} » n'est rattaché à aucun bien`;
    case 'date_conflict':
      return `« ${item.title} » a une date incohérente`;
    case 'coherence_alert':
    case 'data_inconsistency':
      return `Incohérence détectée — ${item.title}`;
    case 'missing_date':
      return `« ${item.title} » n'a pas de date`;
    case 'validation_required':
      return `Informations à valider — ${item.title}`;
    case 'document_type_to_confirm':
      return `Type à confirmer — ${item.title}`;
    case 'missing_required_label':
      return `Informations manquantes — ${item.title}`;
    case 'asset_suggestion_to_confirm':
      return `Suggestion à confirmer — ${item.title}`;
    case 'supplier_to_confirm':
      return `Fournisseur à confirmer — ${item.title}`;
    case 'supplier_conflict':
      return `Coordonnées fournisseur à vérifier — ${item.title}`;
    default:
      return item.subLabel ? `${item.title} — ${item.subLabel}` : item.title;
  }
}

function reasonSummary(items: HomeItem[]): string {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.reason ?? 'other';
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const [reason, count] of Object.entries(counts)) {
    switch (reason) {
      case 'missing_asset':
        parts.push(count === 1 ? '1 document sans bien rattaché' : `${count} documents sans bien rattaché`);
        break;
      case 'date_conflict':
        parts.push(count === 1 ? '1 date incohérente' : `${count} dates incohérentes`);
        break;
      case 'coherence_alert':
      case 'data_inconsistency':
        parts.push(count === 1 ? '1 incohérence détectée' : `${count} incohérences détectées`);
        break;
      case 'missing_date':
        parts.push(count === 1 ? '1 date manquante' : `${count} dates manquantes`);
        break;
      case 'validation_required':
      case 'document_type_to_confirm':
      case 'asset_suggestion_to_confirm':
        parts.push(count === 1 ? '1 information à valider' : `${count} informations à valider`);
        break;
      case 'supplier_to_confirm':
      case 'supplier_conflict':
        parts.push(count === 1 ? '1 fournisseur à vérifier' : `${count} fournisseurs à vérifier`);
        break;
      default:
        parts.push(count === 1 ? '1 point à voir' : `${count} points à voir`);
        break;
    }
  }
  return parts.join(', ');
}

export function ATraiterMaintenantBlock({ items, total, onItemClick }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="w-full max-w-2xl">
      <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-default)] rounded-xl">
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[color:var(--bg-subtle)] flex items-center justify-center flex-shrink-0 mt-0.5">
              <ListChecks className="w-4 h-4 text-[color:var(--text-tertiary)]" />
            </div>
            <div className="flex-1 min-w-0">
              {total === 1 ? (
                <p className="text-sm text-[color:var(--text-primary)]">
                  {reasonLabel(items[0])}
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">
                    {total} éléments méritent un coup d&apos;œil
                  </p>
                  <p className="text-xs text-[color:var(--text-tertiary)] mt-0.5">
                    {reasonSummary(items)}
                  </p>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {total === 1 ? (
                <button
                  onClick={() => onItemClick?.(items[0])}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--bg-subtle)] hover:bg-[color:var(--bg-hover)] text-[color:var(--text-secondary)] transition-colors"
                >
                  Voir
                  <ArrowRight className="w-3 h-3" />
                </button>
              ) : (
                <Link
                  href="/accueil/a-traiter"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--bg-subtle)] hover:bg-[color:var(--bg-hover)] text-[color:var(--text-secondary)] transition-colors"
                >
                  Voir
                  <ArrowRight className="w-3 h-3" />
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}