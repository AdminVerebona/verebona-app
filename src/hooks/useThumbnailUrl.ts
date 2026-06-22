import { useState, useEffect } from 'react';

// ⚡ OPTIMISATION: Cache en mémoire pour les URLs signées (évite N+1 queries)
interface CachedUrl {
  url: string;
  timestamp: number;
}

const urlCache = new Map<string, CachedUrl>();
const CACHE_TTL = 55 * 60 * 1000; // 55 minutes (URLs signées expirent après 1h)

function getCacheKey(assetId: number, thumbnailUrl: string): string {
  return `${assetId}-${thumbnailUrl}`;
}

function getCachedUrl(key: string): string | null {
  const cached = urlCache.get(key);
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > CACHE_TTL) {
    urlCache.delete(key);
    return null;
  }
  
  return cached.url;
}

function setCachedUrl(key: string, url: string): void {
  urlCache.set(key, {
    url,
    timestamp: Date.now(),
  });
}

export function useThumbnailUrl(assetId: number | null | undefined, thumbnailUrl: string | null | undefined) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // If no thumbnail or no assetId, don't fetch
    if (!thumbnailUrl || !assetId) {
      setSignedUrl(null);
      return;
    }

    // ⚡ OPTIMISATION: Vérifier le cache d'abord
    const cacheKey = getCacheKey(assetId, thumbnailUrl);
    const cachedUrl = getCachedUrl(cacheKey);
    
    if (cachedUrl) {
      setSignedUrl(cachedUrl);
      return;
    }

    let isCancelled = false;

    const fetchSignedUrl = async () => {
      setIsLoading(true);
      try {
        const token = localStorage.getItem('bearer_token');
        if (!token) return;

        const response = await fetch(`/api/assets/${assetId}/thumbnail`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          console.error('Failed to fetch signed thumbnail URL');
          return;
        }

        const data = await response.json();
        
        if (!isCancelled && data.url) {
          // ⚡ OPTIMISATION: Mettre en cache l'URL signée
          setCachedUrl(cacheKey, data.url);
          setSignedUrl(data.url);
        }
      } catch (error) {
        console.error('Error fetching thumbnail URL:', error);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchSignedUrl();

    return () => {
      isCancelled = true;
    };
  }, [assetId, thumbnailUrl]);

  return { signedUrl, isLoading };
}