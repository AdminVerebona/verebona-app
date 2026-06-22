"use client";

import { useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, ArrowRight, Package, Loader2, CreditCard } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { toast } from 'sonner';

interface RecoveryAsset {
  id: number;
  label: string;
  lock_state: 'NONE' | 'PENDING_MOVE' | 'PENDING_DELETE';
}

export default function RecoveryPage({ params }: { params: { id: string } }) {
  const { user } = useSession({ required: true });
  const [assets, setAssets] = useState<RecoveryAsset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState<number | null>(null);

  useEffect(() => {
    async function fetchRecoveryAssets() {
      try {
        const data = await apiClient.get<RecoveryAsset[]>(`/api/duos/${params.id}/recovery/assets`);
        setAssets(data);
      } catch (error) {
        console.error('Failed to fetch recovery assets:', error);
        toast.error('Erreur lors du chargement des biens');
      } finally {
        setIsLoading(false);
      }
    }

    if (user) {
      fetchRecoveryAssets();
    }
  }, [user, params.id]);

  const handleRequestMove = async (assetId: number) => {
    setIsRequesting(assetId);
    try {
      // Pour le move request en recovery, on cible le compte personnel de l'utilisateur
      await apiClient.post(`/api/assets/${assetId}/move-request`, {
        target_account_id: user?.id, // En V1 l'account_id est souvent lié au user_id ou stocké séparément. 
                                     // Ici on suppose que le backend sait vers quel compte perso déplacer.
      });
      toast.success('Demande de déplacement envoyée');
      
      // Rafraîchir la liste
      const data = await apiClient.get<RecoveryAsset[]>(`/api/duos/${params.id}/recovery/assets`);
      setAssets(data);
    } catch (error: any) {
      console.error('Move request error:', error);
      toast.error(error.message || 'Erreur lors de la demande');
    } finally {
      setIsRequesting(null);
    }
  };

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-[color:var(--accent)]" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-6 flex flex-col md:flex-row gap-6 items-start md:items-center">
          <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 space-y-2">
            <h1 className="text-xl font-semibold text-amber-700 dark:text-amber-400">
              Espace Duo en mode Récupération
            </h1>
            <p className="text-sm text-amber-600 dark:text-amber-300/80 leading-relaxed">
              L'abonnement Duo est suspendu suite à un défaut de paiement. Vous ne pouvez plus accéder aux documents mais vous pouvez demander le déplacement de vos biens vers votre compte personnel.
            </p>
          </div>
          <Link href="/mon-compte/offres">
            <Button className="bg-amber-600 hover:bg-amber-700 text-white gap-2 rounded-full shadow-lg transition-all hover:scale-105">
              <CreditCard className="w-4 h-4" />
              Régulariser l'abonnement
            </Button>
          </Link>
        </div>

        <Card className="border-[color:var(--border-subtle)] shadow-relief-md overflow-hidden rounded-2xl">
          <CardHeader className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Biens du Duo</CardTitle>
                <CardDescription>
                  Sélectionnez les biens que vous souhaitez récupérer dans votre espace personnel.
                </CardDescription>
              </div>
              <Badge variant="outline" className="bg-[color:var(--bg-page)]">
                {assets.length} bien{assets.length > 1 ? 's' : ''}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {assets.length === 0 ? (
              <div className="p-12 text-center text-[color:var(--text-muted)]">
                Aucun bien trouvé dans cet espace.
              </div>
            ) : (
              <div className="divide-y divide-[color:var(--border-subtle)]">
                {assets.map((asset) => (
                  <div key={asset.id} className="p-4 flex items-center justify-between hover:bg-[color:var(--bg-page)] transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-[color:var(--bg-card)] flex items-center justify-center shadow-relief-sm">
                        <Package className="w-5 h-5 text-[color:var(--text-muted)]" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-[color:var(--text-primary)]">
                          {asset.label}
                        </div>
                        {asset.lock_state !== 'NONE' && (
                          <Badge variant="secondary" className="mt-1 text-[10px] uppercase tracking-wider h-4">
                            {asset.lock_state === 'PENDING_MOVE' ? 'Déplacement en cours' : 'Suppression en cours'}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant={asset.lock_state === 'NONE' ? 'default' : 'secondary'}
                      disabled={asset.lock_state !== 'NONE' || isRequesting === asset.id}
                      onClick={() => handleRequestMove(asset.id)}
                      className="gap-2 rounded-full h-9 px-4"
                    >
                      {isRequesting === asset.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <span>Récupérer</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </>
  );
}
