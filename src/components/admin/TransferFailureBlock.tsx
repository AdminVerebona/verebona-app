"use client";

import {
  TRANSFER_STEP_LABELS, type AttachmentTransferFailure,
} from '@/services/ai/gateway/diagnostics/taxonomy';
import { transferHypotheses } from '@/services/ai/transfer/transfer-hypotheses';

/**
 * Lot 113R (carte #717) — réponse du fournisseur à l'ENVOI du document
 * (conservée sans secret avec CETTE tentative) : cause fournisseur, distincte
 * de la classification interne et de la suspension. Partagé avec l'écran
 * Fournisseur IA (test d'envoi).
 */
export function TransferFailureBlock({ t, testId = 'execution-call-transfer' }: { t: AttachmentTransferFailure; testId?: string }) {
  const hyp = transferHypotheses(t);
  return (
    <div className="rounded-md border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-2 space-y-1" data-testid={testId}>
      <p className="font-medium text-[color:var(--text-primary)]">Réponse du fournisseur à l’envoi du document (aucune génération demandée)</p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
        <dt className="text-[color:var(--text-muted)]">Étape</dt><dd>{TRANSFER_STEP_LABELS[t.step] ?? t.step}</dd>
        <dt className="text-[color:var(--text-muted)]">Endpoint</dt><dd className="font-mono break-all">{t.endpoint}</dd>
        <dt className="text-[color:var(--text-muted)]">Statut HTTP</dt><dd>{t.httpStatus ?? (t.kind === 'network' ? `aucune réponse${t.networkCode ? ` (${t.networkCode})` : ''}` : '—')}</dd>
        <dt className="text-[color:var(--text-muted)]">Statut fournisseur</dt><dd>{t.providerStatus ?? '—'}{t.providerCode !== null ? ` (code ${t.providerCode})` : ''}</dd>
        <dt className="text-[color:var(--text-muted)]">Raison</dt><dd>{t.providerReason ?? '—'}{t.providerDomain ? ` · ${t.providerDomain}` : ''}</dd>
        <dt className="text-[color:var(--text-muted)]">Message</dt>
        <dd className="break-all" data-testid="transfer-provider-message">
          {t.providerMessage ?? (t.providerDetail === 'NONE' ? 'Aucun détail fourni par le fournisseur (corps de réponse vide).' : t.providerDetail === 'TEXT' ? 'Réponse non JSON : voir l’extrait.' : '—')}
        </dd>
        <dt className="text-[color:var(--text-muted)]">Identifiant de requête</dt><dd className="font-mono break-all">{t.requestId ?? 'non fourni'}</dd>
        {t.providerMetadata && Object.keys(t.providerMetadata).length > 0 && (<>
          <dt className="text-[color:var(--text-muted)]">Métadonnées</dt>
          <dd className="font-mono break-all">{Object.entries(t.providerMetadata).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd>
        </>)}
      </dl>
      {t.body.excerpt && (
        <details>
          <summary className="cursor-pointer text-[color:var(--text-muted)]">Corps de la réponse ({t.body.kind}, {t.body.length ?? '?'} caractères{t.body.truncated ? ', extrait borné' : ''})</summary>
          <pre className="whitespace-pre-wrap break-all mt-1">{t.body.excerpt}</pre>
        </details>
      )}
      {t.details.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[color:var(--text-muted)]">Détails structurés ({t.details.length})</summary>
          <pre className="whitespace-pre-wrap break-all mt-1">{JSON.stringify(t.details, null, 2)}</pre>
        </details>
      )}
      {hyp.length > 0 && (
        <div className="space-y-0.5" data-testid="transfer-hypotheses">
          <p className="text-[color:var(--text-muted)]">Pistes à vérifier (hypothèses, à confirmer par la réponse ci-dessus) :</p>
          <ul className="list-disc pl-4">
            {hyp.map((h) => <li key={h.code}>{h.text} <span className="text-[color:var(--text-muted)]">— {h.check}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

