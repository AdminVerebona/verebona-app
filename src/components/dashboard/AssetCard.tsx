import React, { memo } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { getAssetIcon, CATEGORY_LABELS } from '@/lib/asset-icons';
import { useThumbnailUrl } from '@/hooks/useThumbnailUrl';
import { Skeleton } from '@/components/ui/skeleton';
import { Folder, AlertCircle } from 'lucide-react';

interface AssetCardProps {
  id: number;
  name: string;
  category: string;
  subtype?: string;
  status?: string;
  thumbnailUrl?: string | null;
  signedThumbnailUrl?: string | null;
  documentCount?: number;
  documentLabels?: string[];
  priority?: boolean;
  // micro-signaux (optionnels, enrichis par /api/home/summary)
  todoCount?: number;
  nextDate?: string | null;
  nextDateTitle?: string | null;
}


export const AssetCard = memo(({
  id,
  name,
  category,
  subtype,
  status = 'EN_SERVICE',
  thumbnailUrl,
  signedThumbnailUrl,
  documentCount = 0,
  documentLabels = [],
  priority = false,
  todoCount = 0,
  nextDate,
  nextDateTitle,
}: AssetCardProps) => {
  const Icon = getAssetIcon(category, subtype, name);
  const isInactive = status === 'ARCHIVED' || status === 'TRANSMIS';

  const statusLabel =
    status === 'TRANSMIS' ? 'Transmis' :
    status === 'ARCHIVED' ? 'Archivé' :
    status === 'EN_MAINTENANCE' ? 'Maintenance' :
    status === 'HORS_SERVICE' ? 'Hors service' :
    'Actif';

  // Use pre-signed URL from server if available, otherwise fall back to client-side fetch
  const { signedUrl: hookSignedUrl, isLoading: thumbnailLoading } = useThumbnailUrl(
    signedThumbnailUrl ? null : id,
    signedThumbnailUrl ? null : thumbnailUrl
  );
  const signedUrl = signedThumbnailUrl ?? hookSignedUrl;

  // Micro-signal à afficher en priorité
  const hasTodo = todoCount > 0;
  const hasNextDate = !!nextDate;

  const cardContent = (
    <div className={`relative rounded-xl overflow-hidden h-40 transition-all duration-300 ${
      isInactive
        ? 'opacity-50 cursor-default'
        : 'cursor-pointer hover:scale-[1.02] hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(0,0,0,0.4)]'
    }`}>

        {/* Background */}
        {thumbnailLoading ? (
          <Skeleton className="absolute inset-0 w-full h-full rounded-2xl" />
        ) : signedUrl ? (
          <img
            src={signedUrl}
            alt={name}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-muted to-muted/60 flex items-center justify-center">
            <Icon className="w-16 h-16 text-muted-foreground/20" />
          </div>
        )}

        {/* Dark overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/10" />

        {/* Inactive overlay */}
        {isInactive && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 rounded-2xl">
            <span className="text-white/80 text-xs font-semibold uppercase tracking-widest">
              {statusLabel}
            </span>
          </div>
        )}

        {/* Content */}
        <div className="absolute inset-0 z-10 flex flex-col justify-between p-3">
          {/* Top: icon + category + badge */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-md bg-white/15 backdrop-blur-sm flex items-center justify-center">
                <Icon className="w-2.5 h-2.5 text-white" />
              </div>
              <span className="text-white/80 text-[9px] font-medium uppercase tracking-wider drop-shadow">
                {CATEGORY_LABELS[category] || category}
                {subtype && ` · ${subtype}`}
              </span>
            </div>
            {!isInactive && (
            <Badge variant="active" className="bg-white/15 backdrop-blur-sm border-white/20 text-white text-[9px] px-1.5 h-4 uppercase tracking-wider">
              {statusLabel}
            </Badge>
            )}
          </div>

          {/* Bottom: name + stats + micro-signal */}
          <div className="space-y-1">
            <h3 className="font-bold text-white text-sm leading-tight drop-shadow-lg">{name}</h3>

            {/* Micro-signal (priorité sur les docs) */}
            {!isInactive && (
              <div className="flex items-center gap-2 flex-wrap">
                {hasTodo && (
                  <div className="flex items-center gap-1 bg-amber-500/25 border border-amber-500/30 rounded-full px-2 py-0.5">
                    <AlertCircle className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                    <span className="text-[9.5px] font-semibold text-amber-300">
                      {todoCount === 1 ? '1 action à faire' : `${todoCount} actions à faire`}
                    </span>
                  </div>
                )}

                {/* Compteur docs */}
                <div className="flex items-center gap-1 text-white/60 text-[10px]">
                  <Folder className="w-2.5 h-2.5 text-[#f59e0b] shrink-0" />
                  <span className="text-white/80 font-semibold">{documentCount}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
  );

  return isInactive ? cardContent : (
    <Link href={`/assets/${id}`}>
      {cardContent}
    </Link>
  );
});

AssetCard.displayName = 'AssetCard';
