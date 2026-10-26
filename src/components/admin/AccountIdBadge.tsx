"use client";

/**
 * Identifiant du compte, lisible et copiable — BO › Comptes (lot 85E, ticket
 * PO du 23/10/2026 : « faire apparaître l'ID compte »).
 *
 * Même composant sur la liste et sur la fiche, desktop ET mobile : libellé
 * « ID 42 » en chiffres à chasse fixe (aucun retour à la ligne), bouton de
 * copie avec une zone tactile de 32 px sur mobile (24 px dès `sm`). Le clic
 * ne se propage pas (la ligne de la liste ouvre la fiche). Seul l'identifiant
 * interne du compte est montré : il est déjà renvoyé par les routes BO —
 * aucune donnée nouvelle (ni Stripe, ni e-mail).
 */
import { useState, type MouseEvent } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';

const ACCOUNT_ID_LABEL = 'ID';

/** Texte affiché et copié : l'identifiant seul (collable tel quel dans la recherche). */
export const accountIdText = (id: number): string => String(id);

export function AccountIdBadge({ id, className = '' }: { id: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copier = async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (await copyText(accountIdText(id))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(`ID du compte copié : ${id}`, { duration: 1500 });
    } else {
      toast.error('Copie impossible dans ce navigateur.');
    }
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground ${className}`}
      data-testid="bo-account-id"
    >
      <span>{ACCOUNT_ID_LABEL}</span>
      <span className="font-mono tabular-nums text-foreground select-all" data-testid="bo-account-id-value">{accountIdText(id)}</span>
      <button
        type="button"
        onClick={copier}
        aria-label={`Copier l’ID du compte ${id}`}
        title="Copier l’ID du compte"
        className="inline-flex h-8 w-8 sm:h-6 sm:w-6 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-primary)]"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </span>
  );
}
