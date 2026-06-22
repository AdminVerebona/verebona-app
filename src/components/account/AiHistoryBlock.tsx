'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api-client';
import { Bot, ArrowRight, ExternalLink, Lock, Crown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface AiHistoryItem {
  id: number;
  fieldKey: string;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string;
  createdAt: string;
  assetId: number;
  assetName: string;
  assetFileId: number | null;
  docTitle: string | null;
}

function formatValue(val: string | null): string {
  if (!val || val === 'null') return '—';
  if (val === 'true') return 'Oui';
  if (val === 'false') return 'Non';
  return val;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days}j`;
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Exemples fictifs affichés en version locked
const LOCKED_EXAMPLES = [
  { id: -1, fieldLabel: 'Assureur', action: 'complété', assetName: 'Appartement Lyon', docTitle: 'Contrat assurance.pdf', detail: 'Allianz' },
  { id: -2, fieldLabel: 'Prime annuelle assurance (€)', action: 'complété', assetName: 'Polo', docTitle: "Avis d'échéance.pdf", detail: '313,59 €' },
];

export function AiHistoryBlock({ locked = false }: { locked?: boolean }) {
  const router = useRouter();
  const [item, setItem] = useState<AiHistoryItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (locked) return;
    apiClient.get<{ items: AiHistoryItem[]; total: number }>(
      `/api/ai-history?limit=1&offset=0`
    ).then(data => {
      setItem(data.items?.[0] ?? null);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [locked]);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[#3b82f6]" />
            <CardTitle className="text-base">Historique des modifications automatiques</CardTitle>
          </div>
          {locked && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">Premium</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {locked ? (
          <div>
            <div className="relative">
              <div className="divide-y divide-border -mx-2 blur-[3px] pointer-events-none select-none">
                {LOCKED_EXAMPLES.map(ex => (
                  <div key={ex.id} className="flex items-start gap-3 px-2 py-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 mt-2 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-snug">
                        <span className="font-medium">{ex.fieldLabel}</span> {ex.action} sur <span className="underline">{ex.assetName}</span>
                        {ex.docTitle && <> depuis <span className="italic">"{ex.docTitle}"</span></>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{ex.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/60">
                <div className="flex flex-col items-center gap-2 text-center px-4">
                  <Lock className="w-4 h-4 text-blue-400" />
                  <p className="text-sm font-medium">Disponible en Premium</p>
                  <p className="text-xs text-muted-foreground">Suivez toutes les modifications effectuées automatiquement sur vos biens.</p>
                </div>
                <Button
                  size="sm" variant="outline"
                  className="border-blue-500/40 text-blue-400 hover:bg-blue-500/10 gap-1.5 rounded-full"
                  onClick={() => router.push('/mon-compte/offres')}
                >
                  <Crown className="w-3.5 h-3.5" />
                  Passer Premium
                </Button>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-start gap-3">
            <Skeleton className="h-3 w-3 mt-1.5 rounded-full flex-shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ) : !item ? (
          <p className="text-sm text-muted-foreground">
            Aucune modification automatique pour l'instant. Les champs complétés automatiquement lors de l'analyse de vos documents apparaîtront ici.
          </p>
        ) : (
          <div>
            {/* Dernière entrée */}
            <div className="flex items-start gap-3 px-2 py-2">
              <div className="w-1.5 h-1.5 rounded-full bg-violet-400 mt-2 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm leading-snug">
                    <span className="font-medium">{item.fieldLabel}</span>
                    {' '}{item.oldValue ? 'modifié' : 'complété'} sur{' '}
                    <Link
                      href={`/assets/${item.assetId}`}
                      className="text-[color:var(--text-muted)] hover:text-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
                    >
                      {item.assetName}
                      <ExternalLink className="w-3 h-3 flex-shrink-0" />
                    </Link>
                    {item.docTitle && (
                      <> depuis <span className="italic text-muted-foreground">"{item.docTitle}"</span></>
                    )}
                  </p>
                  <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0 mt-0.5">
                    {timeAgo(item.createdAt)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.oldValue ? (
                    <>
                      <span className="line-through opacity-50">{formatValue(item.oldValue)}</span>
                      {' → '}
                      <span className="text-foreground/80">{formatValue(item.newValue)}</span>
                    </>
                  ) : (
                    <span className="text-foreground/70">{formatValue(item.newValue)}</span>
                  )}
                </p>
              </div>
            </div>

            {/* Lien vers la page dédiée */}
            <div className="mt-2 -mx-2 px-2 pt-2 border-t border-border">
              <Button
                variant="ghost" size="sm"
                className="text-muted-foreground gap-1.5 w-full justify-center hover:text-foreground"
                asChild
              >
                <Link href="/mon-compte/enrichissements">
                  Voir tout l'historique
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
