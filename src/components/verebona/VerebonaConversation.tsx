'use client';
/** Liste des messages — CDC §7 / §33. Défilement + région live. */
import { useEffect, useState } from 'react';
import type { VerebonaMessage } from '@/lib/verebona/useVerebona';
import { processingStatus } from '@/lib/verebona/assistant-ui';
import { VerebonaMessageItem } from './VerebonaMessage';

export interface VerebonaConversationProps {
  messages: VerebonaMessage[];
  isLoading: boolean;
  onFeedback: (messageId: string, v: 'helpful' | 'not_helpful', reason?: string) => void;
  onClarify: (clarificationId: string, choice: { choiceId: string; label: string; secondaryLabel?: string }) => void;
  onConfirmPlan?: (planId: string) => void;
  onCancelPlan?: (planId: string) => void;
  /** « Réessayer » (RETRY_REQUEST, §27.11). */
  onRetry?: (fromMessageId: string) => void;
}

export function VerebonaConversation({ messages, isLoading, onFeedback, onClarify, onConfirmPlan, onCancelPlan, onRetry }: VerebonaConversationProps) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {messages.map((m) => (
        <VerebonaMessageItem key={m.id} message={m} onFeedback={onFeedback} onClarify={onClarify} onConfirmPlan={onConfirmPlan} onCancelPlan={onCancelPlan} onRetry={onRetry} />
      ))}
      {isLoading && <ProcessingStatus />}
    </div>
  );
}

/** Statut court qui suit le temps écoulé (§7.7), annoncé poliment (§33). */
function ProcessingStatus() {
  const [debut] = useState(() => Date.now());
  const [maintenant, setMaintenant] = useState(debut);
  useEffect(() => {
    const t = setInterval(() => setMaintenant(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <div className="text-sm text-muted-foreground" role="status">{processingStatus(maintenant - debut)}</div>;
}
