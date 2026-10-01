"use client"

/**
 * Annonces de vente hors PDF (CDC 16 VENTE-RULE-002, lot 19) : texte de
 * l'annonce courte et de l'annonce détaillée, bouton « Copier », rappel de
 * relecture. Composition déterministe côté serveur (`saleAds`) ; aucun appel
 * modèle. Composants et jetons de l'écran de préparation uniquement.
 */

import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { PreparationDto } from '@/services/exports/v12/preparation/types';
import { Callout, Eyebrow } from './ui';

type SaleAds = NonNullable<PreparationDto['saleAds']>;

/** Rappel de relecture affiché au-dessus des annonces. */
export const SALE_AD_REVIEW_MESSAGE = 'Relisez avant publication : ces annonces reprennent les informations du dossier, vérifiez-les et complétez-les si besoin.';

function AdBlock({ id, title, text }: { id: string; title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Annonce copiée');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier l’annonce');
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>{title}</Eyebrow>
        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void copy()} aria-describedby={id}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? 'Copiée' : 'Copier'}
        </Button>
      </div>
      <p id={id} className="whitespace-pre-line rounded-lg border border-border bg-[var(--accent-soft)] px-3.5 py-3 text-[13px] leading-relaxed">{text}</p>
    </div>
  );
}

export function SaleAdsPanel({ ads }: { ads: SaleAds }) {
  return (
    <section id="prep-sec-sale-ads" aria-labelledby="prep-sale-ads-title" className="scroll-mt-24 rounded-xl border border-border bg-card shadow-[var(--shadow-sm)]">
      <header className="px-4 py-3.5 sm:px-5">
        <h2 id="prep-sale-ads-title" className="text-[15px] font-semibold">Annonces de vente</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">À publier vous-même : elles ne figurent pas dans le PDF.</p>
      </header>
      <div className="space-y-4 border-t border-border px-4 py-4 sm:px-5">
        <Callout tone="warning" icon={<AlertTriangle />}>{SALE_AD_REVIEW_MESSAGE}</Callout>
        {ads.priceMissing && (
          <Callout tone="info">Aucun prix n’est indiqué : renseignez le prix souhaité dans les conditions de vente pour qu’il apparaisse.</Callout>
        )}
        <AdBlock id="prep-sale-ad-short" title="Annonce courte" text={ads.short} />
        <AdBlock id="prep-sale-ad-detailed" title="Annonce détaillée" text={ads.detailed} />
      </div>
    </section>
  );
}
