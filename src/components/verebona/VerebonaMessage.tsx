'use client';
/**
 * Un message (utilisateur ou assistant) avec actions, sources, feedback — CDC §7 / §19 / §22.
 *
 * Exécute les actions d'interface (§19.8, §27.9, §27.11) :
 *   - SHOW_SOURCES : déplie le panneau des sources du message ;
 *   - SHOW_EXPLANATION : charge et affiche l'explication enregistrée ;
 *   - RETRY_REQUEST : renvoie la dernière question (`onRetry`).
 * Un message d'erreur (§4.2) est signalé comme tel, avec ses suites.
 */
import { useState } from 'react';
import { OFFLINE_PENDING_LABEL } from '@/lib/verebona/offline';
import type { VerebonaAction, VerebonaMessage } from '@/lib/verebona/useVerebona';
import { VerebonaActions } from './VerebonaActions';
import { VerebonaSources } from './VerebonaSources';
import { VerebonaFeedback } from './VerebonaFeedback';
import { VerebonaCommandPlan } from './VerebonaCommandPlan';
import { VerebonaExplanation } from './VerebonaExplanation';
import { VerebonaResultGroups } from './VerebonaResultGroups';

export interface VerebonaMessageItemProps {
  message: VerebonaMessage;
  onFeedback: (messageId: string, v: 'helpful' | 'not_helpful', reason?: string) => void;
  onClarify: (clarificationId: string, choice: { choiceId: string; label: string; secondaryLabel?: string }) => void;
  onConfirmPlan?: (planId: string) => void;
  onCancelPlan?: (planId: string) => void;
  /** « Annuler » une action exécutée (15 minutes, plans réversibles). */
  onUndoPlan?: (planId: string) => void;
  /** Renvoie la dernière question précédant ce message (RETRY_REQUEST). */
  onRetry?: (fromMessageId: string) => void;
}

export function VerebonaMessageItem({ message, onFeedback, onClarify, onConfirmPlan, onCancelPlan, onUndoPlan, onRetry }: VerebonaMessageItemProps) {
  const isUser = message.role === 'user';
  const isError = !isUser && Boolean(message.error);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [explanationOpen, setExplanationOpen] = useState(false);

  const onAction = (a: VerebonaAction) => {
    switch (a.type) {
      case 'SHOW_SOURCES': setSourcesOpen(true); break;
      case 'SHOW_EXPLANATION': setExplanationOpen((o) => !o); break;
      case 'RETRY_REQUEST': onRetry?.(message.id); break;
      default: break;
    }
  };

  // « Voir les sources » n'a de sens que si le panneau existe.
  const actions = (message.actions ?? []).filter((a) => a.type !== 'SHOW_SOURCES' || message.sourcesAvailable);

  return (
    <div className={isUser ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[95%]'}>
      <div
        role={isError ? 'alert' : undefined}
        className={`whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : isError ? 'border border-destructive/40 bg-destructive/5' : 'bg-muted'}`}
      >
        {message.content}
      </div>
      {/* §30.6 : question conservée hors ligne, envoyée au retour du réseau. */}
      {isUser && message.pendingOffline && (
        <p role="status" className="mt-1 text-right text-[11px] text-muted-foreground">{OFFLINE_PENDING_LABEL}</p>
      )}

      {!isUser && message.clarification && (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.clarification.choices.map((c) => (
            <button
              key={c.choiceId}
              onClick={() => onClarify(message.clarification!.clarificationId, c)}
              className="rounded-full border px-3 py-1 text-xs hover:bg-muted"
            >
              {c.label}{c.secondaryLabel ? ` · ${c.secondaryLabel}` : ''}
            </button>
          ))}
        </div>
      )}

      {!isUser && !isError && message.resultGroups && message.resultGroups.length > 0 && (
        <VerebonaResultGroups groups={message.resultGroups} />
      )}

      {!isUser && message.commandPlan && onConfirmPlan && onCancelPlan && (
        <VerebonaCommandPlan plan={message.commandPlan} onConfirm={onConfirmPlan} onCancel={onCancelPlan} onUndo={onUndoPlan} />
      )}

      {!isUser && actions.length > 0 && (
        <VerebonaActions actions={actions} onAction={onAction} />
      )}

      {!isUser && explanationOpen && <VerebonaExplanation messageId={message.id} />}

      {!isUser && message.sourcesAvailable && (
        <VerebonaSources
          messageId={message.id}
          count={message.sourceCount ?? 0}
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
        />
      )}

      {!isUser && !isError && (
        <VerebonaFeedback messageId={message.id} onFeedback={onFeedback} />
      )}
    </div>
  );
}
