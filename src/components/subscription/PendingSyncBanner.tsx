'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PendingSyncBannerProps {
  onSynced?: () => void;
}

export function PendingSyncBanner({ onSynced }: PendingSyncBannerProps) {
  const [showRefresh, setShowRefresh] = useState(false);
  const [showSlowMessage, setShowSlowMessage] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  // Background polling — check every 5s for up to 2 minutes
  useEffect(() => {
    let stopped = false;
    let count = 0;
    const MAX = 24; // 24 × 5s = 2 min
    const interval = setInterval(async () => {
      if (stopped || count >= MAX) { clearInterval(interval); return; }
      count++;
      try {
        const res = await fetch('/api/billing/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const plan = data.plan_type?.toUpperCase();
          const status = data.subscription_status?.toUpperCase();
          const isSynced = (status === 'TRIALING' || status === 'ACTIVE') || (plan && plan !== 'STANDARD');
          if (isSynced) {
            stopped = true;
            clearInterval(interval);
            onSynced?.();
          }
        }
      } catch {}
      if (count >= 3 && !stopped) setShowSlowMessage(true);
    }, 5000);
    const t1 = setTimeout(() => setShowRefresh(true), 8000);
    return () => { stopped = true; clearInterval(interval); clearTimeout(t1); };
  }, [onSynced]);

  const handleRefresh = async () => {
    setIsChecking(true);
    setShowSlowMessage(false);
    try {
      const res = await fetch('/api/billing/me', {
      credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        const plan = data.plan_type?.toUpperCase();
        const status = data.subscription_status?.toUpperCase();
        const isSynced = (status === 'TRIALING' || status === 'ACTIVE') || (plan && plan !== 'STANDARD');
        if (isSynced) {
          onSynced?.();
          return;
        }
      }
    } catch {}
    setIsChecking(false);
    setShowSlowMessage(true);
  };

  return (
    <div className="w-full bg-blue-950/60 border border-blue-500/30 rounded-lg px-4 py-3 flex items-center gap-3">
      <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-blue-200 font-medium">
          Votre abonnement est en cours de mise à jour.
        </p>
        {showSlowMessage && (
          <p className="text-xs text-blue-300 mt-0.5">
            La mise à jour prend plus de temps que prévu.
          </p>
        )}
      </div>
      {showRefresh && (
        <Button
          size="sm"
          variant="outline"
          className="border-blue-500/50 text-blue-300 hover:bg-blue-900/40 flex-shrink-0"
          onClick={handleRefresh}
          disabled={isChecking}
        >
          {isChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
          Actualiser
        </Button>
      )}
    </div>
  );
}
