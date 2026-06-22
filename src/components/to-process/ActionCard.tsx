"use client"

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  Link2Off,
  CheckCircle2,
  HelpCircle,
  FileText,
  Calendar,
  Wrench,
  Building2,
  ArrowRight,
  BellOff,
  Loader2,
  Clock,
  Home,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  ToProcessItem, ToProcessFamily, Priority, PrimaryAction,
} from '@/types/to-process';
import { FAMILY_LABELS } from '@/types/to-process';

// ─── Family config ───────────────────────────────────────────────────────

const FAMILY_STYLE: Record<ToProcessFamily, { color: string; bg: string; border: string; icon: React.ReactNode; dot: string }> = {
  arbitrate: {
    color: 'text-[#f97316]',
    bg: 'bg-[#f97316]/10',
    border: 'border-[#f97316]/30',
    icon: <AlertTriangle className="w-4 h-4" />,
    dot: '#f97316',
  },
  attach: {
    color: 'text-[#3b82f6]',
    bg: 'bg-[#3b82f6]/10',
    border: 'border-[#3b82f6]/30',
    icon: <Link2Off className="w-4 h-4" />,
    dot: '#3b82f6',
  },
  confirm: {
    color: 'text-[#10b981]',
    bg: 'bg-[#10b981]/10',
    border: 'border-[#10b981]/30',
    icon: <CheckCircle2 className="w-4 h-4" />,
    dot: '#10b981',
  },
  complete: {
    color: 'text-[#a78bfa]',
    bg: 'bg-[#a78bfa]/10',
    border: 'border-[#a78bfa]/30',
    icon: <HelpCircle className="w-4 h-4" />,
    dot: '#a78bfa',
  },
};

const PRIORITY_STYLE: Record<Priority, { label: string; color: string }> = {
  high: { label: 'Haute', color: 'text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/30' },
  medium: { label: 'Moyenne', color: 'text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30' },
  low: { label: 'Basse', color: 'text-[#6b7280] bg-[#6b7280]/10 border-[#6b7280]/30' },
};

const OBJECT_TYPE_ICON: Record<string, React.ReactNode> = {
  document: <FileText className="w-3.5 h-3.5" />,
  agenda: <Calendar className="w-3.5 h-3.5" />,
  equipment: <Wrench className="w-3.5 h-3.5" />,
  supplier: <Building2 className="w-3.5 h-3.5" />,
};

// ─── Props ───────────────────────────────────────────────────────────────

interface ActionCardProps {
  item: ToProcessItem;
  onPrimaryAction: (item: ToProcessItem) => void;
  onSecondaryAction: (item: ToProcessItem, action: string) => void;
  onViewDetail: (item: ToProcessItem) => void;
  isResolving?: boolean;
  renderInline?: (item: ToProcessItem) => React.ReactNode;
}

// ─── Action Card ─────────────────────────────────────────────────────────

export function ActionCard({
  item,
  onPrimaryAction,
  onSecondaryAction,
  onViewDetail,
  isResolving,
  renderInline,
}: ActionCardProps) {
  const familyStyle = FAMILY_STYLE[item.family] ?? FAMILY_STYLE.attach;
  const priorityStyle = PRIORITY_STYLE[item.priority] ?? PRIORITY_STYLE.low;

  return (
    <Card className="border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-[#3b82f6]/40 transition-all overflow-hidden">
      <CardContent className="p-0">
        {/* Priority indicator bar */}
        {item.priority === 'high' && (
          <div className="h-1 bg-gradient-to-r from-[#ef4444] to-[#f97316]" />
        )}

        <div className="p-4">
          {/* Header: Family badge + Priority */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${familyStyle.color} ${familyStyle.bg} ${familyStyle.border}`}>
              {familyStyle.icon}
              {FAMILY_LABELS[item.family]}
            </span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${priorityStyle.color}`}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: priorityStyle.color.replace('text-[', '').replace(']', '') }} />
              {priorityStyle.label}
            </span>
          </div>

          {/* Title */}
          <h3 className="font-semibold text-sm text-[color:var(--text-primary)] mb-1 leading-snug">
            {item.actionTitle}
          </h3>

          {/* Object */}
          <div className="flex items-center gap-1.5 mb-1">
            {OBJECT_TYPE_ICON[item.objectType]}
            <span className="text-xs text-[color:var(--text-secondary)] truncate">
              {item.objectTitle}
            </span>
          </div>

          {/* Badge */}
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 mt-1 mb-2 font-normal">
            {item.badge}
          </Badge>

          {/* Context */}
          {item.context.assetName && (
            <p className="text-[11px] text-[color:var(--text-muted)] mt-1">
              <Home className="w-3 h-3 inline mr-0.5" />
              {item.context.assetName}
            </p>
          )}

          {/* Conflicting values (for arbitrate) */}
          {item.context.conflictingValues && item.context.conflictingValues.length > 0 && (
            <div className="mt-2 space-y-1 rounded-lg bg-[rgba(249,115,22,0.05)] border border-[#f97316]/15 p-2">
              {item.context.conflictingValues.map((cv, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-[color:var(--text-muted)] shrink-0">{cv.label}</span>
                  <span className="text-[color:var(--text-secondary)] truncate text-right font-medium">{cv.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Suggested value (for confirm) */}
          {item.context.suggestedAssetLabel && (
            <div className="mt-2 rounded-lg bg-[rgba(16,185,129,0.05)] border border-[#10b981]/15 px-3 py-2 text-xs text-[color:var(--text-secondary)]">
              Verebona propose : <span className="font-medium text-[#10b981]">{item.context.suggestedAssetLabel}</span>
            </div>
          )}
          {item.context.suggestedSupplierLabel && (
            <div className="mt-2 rounded-lg bg-[rgba(16,185,129,0.05)] border border-[#10b981]/15 px-3 py-2 text-xs text-[color:var(--text-secondary)]">
              Verebona propose : <span className="font-medium text-[#10b981]">{item.context.suggestedSupplierLabel}</span>
            </div>
          )}

          {/* Inline resolution */}
          {renderInline?.(item)}

          {/* Footer: Context date + actions */}
          <div className="mt-3 pt-3 border-t border-[color:var(--border-subtle)] flex items-center justify-between gap-2">
            {item.context.createdAt && (
              <span className="text-[10px] text-[color:var(--text-muted)]">
                {new Date(item.context.createdAt).toLocaleDateString('fr-FR')}
              </span>
            )}
            {!item.context.createdAt && <span />}
            <div className="flex items-center gap-1">
              {/* Primary action */}
              <Button
                size="sm"
                className="h-auto py-1 px-2.5 text-xs font-medium"
                disabled={isResolving}
                onClick={(e) => { e.stopPropagation(); onPrimaryAction(item); }}
              >
                {isResolving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                {getPrimaryActionLabel(item.primaryAction)}
              </Button>

              {/* Snooze */}
              {item.secondaryActions.includes('snooze') && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-1.5 text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[#ef4444]/10"
                        disabled={isResolving}
                        onClick={(e) => { e.stopPropagation(); onSecondaryAction(item, 'snooze'); }}
                      >
                        <BellOff className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p>Mettre de côté</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}

              {/* View detail */}
              {item.secondaryActions.includes('view_detail') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto p-1.5 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                  onClick={(e) => { e.stopPropagation(); onViewDetail(item); }}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getPrimaryActionLabel(action: PrimaryAction): string {
  switch (action) {
    case 'choose_asset': return 'Choisir un bien';
    case 'choose_date': return 'Choisir une date';
    case 'confirm': return 'Confirmer';
    case 'choose_other': return 'Choisir autre chose';
    case 'add_date': return 'Ajouter une date';
    case 'resolve': return 'Résoudre';
    case 'merge': return 'Fusionner';
    case 'keep_separate': return 'Garder séparés';
    case 'fill': return 'Renseigner';
    default: return 'Résoudre';
  }
}