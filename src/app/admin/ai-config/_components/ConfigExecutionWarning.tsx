'use client';

/**
 * Configuration IA — avertissement CONTEXTUEL d'un traitement (lot 84D, CDC
 * Pilotage IA V2 BO-06, BO-11 ; décision PO 12).
 *
 * La configuration ne liste plus d'incidents : quand des exécutions métier du
 * traitement ont échoué ou sont incomplètes sur les sept derniers jours, une
 * seule ligne le signale et donne accès aux exécutions en cause — les cartes
 * d'Exécutions & logs, source unique de ces alertes (aucun comptage répété
 * ici, C-Q9). Même rendu desktop et mobile (ligne qui s'enroule).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

/** Rendu pur (testable sans réseau) ; rien si aucun échec ni incomplète. */
export function ConfigExecutionWarningView({ treatment, show }: { treatment: string; show: boolean }) {
  if (!show) return null;
  return (
    <p role="status" data-testid="config-execution-warning"
      className="flex flex-wrap items-start gap-x-1.5 gap-y-0.5 rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-3 py-2 text-xs text-[color:var(--text-warning-soft)] min-w-0">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
      <span className="min-w-0 break-words">Des exécutions {treatment} ont échoué ou sont incomplètes sur les 7 derniers jours.</span>
      <Link href={`/admin/ai-executions?treatment=${treatment}`} className="text-[color:var(--accent)] hover:underline">
        Voir les exécutions en cause
      </Link>
    </p>
  );
}

export function ConfigExecutionWarning({ treatment }: { treatment: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let vivant = true;
    apiClient.get<{ cards: { failed: number; incomplete: number } }>(`/api/admin/ai/business-executions?${new URLSearchParams({ treatment, days: '7', limit: '1' })}`)
      .then((r) => { if (vivant) setShow(r.cards.failed + r.cards.incomplete > 0); })
      // Avertissement contextuel : une lecture impossible n'affiche rien (la page reste utilisable).
      .catch(() => { if (vivant) setShow(false); });
    return () => { vivant = false; };
  }, [treatment]);
  return <ConfigExecutionWarningView treatment={treatment} show={show} />;
}
