"use client"

import { useState, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { CheckCircle2, ArrowRight, Loader2, Calendar, Building2, FileText, AlertTriangle } from 'lucide-react';
import type { ToProcessItem } from '@/types/to-process';

interface Props {
  item: ToProcessItem | null;
  open: boolean;
  onClose: () => void;
  onResolved: () => void;
}

export function ResolutionDrawer({ item, open, onClose, onResolved }: Props) {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDate(undefined);
    setSelectedAssetId(null);
    setResolving(false);
  }, []);

  const handleResolve = useCallback(async (resolution: string, payload?: Record<string, unknown>) => {
    if (!item) return;
    setResolving(true);
    try {
      await apiClient.post(`/api/to-process/${item.id}/resolve`, {
        resolution,
        ...payload,
      });
      toast.success('Élément résolu');
      reset();
      onResolved();
    } catch {
      toast.error('Impossible de résoudre');
    } finally {
      setResolving(false);
    }
  }, [item, reset, onResolved]);

  if (!item) return null;

  const renderContent = () => {
    // ── Date conflict resolution (À arbitrer — date) ──────────────
    if (item.reason === 'date_conflict') {
      return (
        <div className="mt-6 space-y-6">
          <div>
            <h4 className="text-sm font-medium mb-2">Valeurs en conflit</h4>
            <div className="space-y-2">
              {item.context.conflictingValues?.map((cv, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[rgba(249,115,22,0.05)] border border-[#f97316]/15">
                  <span className="text-xs text-[color:var(--text-muted)]">{cv.label}</span>
                  <span className="text-sm font-medium">{cv.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-3">Choisir une date</h4>
            <DatePicker
              value={date}
              onChange={setDate}
            />
          </div>

          {date && (
            <Button
              className="w-full"
              disabled={resolving}
              onClick={() => handleResolve('choose_date', { date })}
            >
              {resolving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Confirmer cette date
            </Button>
          )}
        </div>
      );
    }

    // ── Supplier contact conflict ────────────────────────────────
    if (item.reason === 'supplier_conflict') {
      return (
        <div className="mt-6 space-y-6">
          <div>
            <h4 className="text-sm font-medium mb-2">Coordonnées contradictoires</h4>
            <div className="space-y-2">
              {item.context.conflictingValues?.map((cv, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[rgba(249,115,22,0.05)] border border-[#f97316]/15">
                  <span className="text-xs text-[color:var(--text-muted)]">{cv.label}</span>
                  <span className="text-sm font-medium">{cv.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium mb-2">Que souhaitez-vous faire ?</h4>
            {item.context.currentValue && (
              <button
                type="button"
                className="w-full text-left p-3 rounded-lg border border-[color:var(--border-subtle)] hover:border-[#3b82f6]/30 transition-colors"
                disabled={resolving}
                onClick={() => handleResolve('keep_current')}
              >
                <p className="text-xs font-medium">Garder la valeur actuelle</p>
                <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{item.context.currentValue}</p>
              </button>
            )}
            {item.context.detectedValue && (
              <button
                type="button"
                className="w-full text-left p-3 rounded-lg border border-[color:var(--border-subtle)] hover:border-[#3b82f6]/30 transition-colors"
                disabled={resolving}
                onClick={() => handleResolve('use_detected')}
              >
                <p className="text-xs font-medium">Utiliser la valeur détectée</p>
                <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">{item.context.detectedValue}</p>
              </button>
            )}
            <button
              type="button"
              className="w-full text-left p-3 rounded-lg border border-[color:var(--border-subtle)] hover:border-[#ef4444]/30 text-[#ef4444] transition-colors"
              disabled={resolving}
              onClick={() => handleResolve('ignored')}
            >
              <p className="text-xs font-medium">Ignorer cette différence</p>
              <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5 text-[color:var(--text-muted)]">Ne rien modifier</p>
            </button>
          </div>
        </div>
      );
    }

    // ── Asset attach (with asset selector) ───────────────────────
    if (item.family === 'attach') {
      return (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-[color:var(--text-secondary)]">
            Sélectionnez le bien auquel rattacher cet élément.
          </p>
          <Button
            className="w-full"
            disabled={resolving}
            onClick={() => onClose()}
          >
            <ArrowRight className="w-4 h-4 mr-2" />
            Ouvrir le sélecteur de bien
          </Button>
        </div>
      );
    }

    // ── Generic resolve ──────────────────────────────────────────
    return (
      <div className="mt-6 space-y-4">
        <p className="text-sm text-[color:var(--text-secondary)]">
          Action à réaliser : <strong>{item.actionTitle}</strong>
        </p>
        <Button
          className="w-full"
          disabled={resolving}
          onClick={() => onClose()}
        >
          <ArrowRight className="w-4 h-4 mr-2" />
          Voir le détail
        </Button>
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) { reset(); onClose(); } }}>
      <SheetContent className="w-full sm:max-w-[480px] overflow-y-auto">
        <div className="px-6">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {item.actionTitle}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {item.objectTitle}
            </SheetDescription>
          </SheetHeader>

          {renderContent()}
        </div>
      </SheetContent>
    </Sheet>
  );
}