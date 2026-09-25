'use client';
/** Un message (utilisateur ou assistant) avec actions, sources, feedback — CDC §7 / §19 / §22. */
import type { VerebonaMessage } from '@/lib/verebona/useVerebona';
import { VerebonaActions } from './VerebonaActions';
import { VerebonaSources } from './VerebonaSources';
import { VerebonaFeedback } from './VerebonaFeedback';
import { VerebonaCommandPlan } from './VerebonaCommandPlan';

export interface VerebonaMessageItemProps {
  message: VerebonaMessage;
  onFeedback: (messageId: string, v: 'helpful' | 'not_helpful', reason?: string) => void;
  onClarify: (clarificationId: string, choice: { choiceId: string; label: string; secondaryLabel?: string }) => void;
  onConfirmPlan?: (planId: string) => void;
  onCancelPlan?: (planId: string) => void;
}

export function VerebonaMessageItem({ message, onFeedback, onClarify, onConfirmPlan, onCancelPlan }: VerebonaMessageItemProps) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[95%]'}>
      <div className={`whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
        {message.content}
      </div>

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

      {!isUser && message.commandPlan && onConfirmPlan && onCancelPlan && (
        <VerebonaCommandPlan plan={message.commandPlan} onConfirm={onConfirmPlan} onCancel={onCancelPlan} />
      )}

      {!isUser && message.actions && message.actions.length > 0 && (
        <VerebonaActions actions={message.actions} />
      )}

      {!isUser && message.sourcesAvailable && (
        <VerebonaSources messageId={message.id} count={message.sourceCount ?? 0} />
      )}

      {!isUser && (
        <VerebonaFeedback messageId={message.id} onFeedback={onFeedback} />
      )}
    </div>
  );
}
