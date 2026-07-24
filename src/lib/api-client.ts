/**
 * API Client — session par cookies HttpOnly (CDC authentification)
 */

interface ApiClientOptions extends RequestInit {
  skipAuth?: boolean;
  skipRetry?: boolean;
  useCache?: boolean;
}

interface ApiError {
  error: string;
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
    public requestId?: string,
    public serverMessage?: string
  ) {
    super(serverMessage || `API Error ${status}: ${code}`);
    this.name = 'ApiClientError';
  }
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const requestCache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(url: string, options: ApiClientOptions): string {
  return `${options.method || 'GET'}:${url}`;
}

function getCachedData<T>(key: string): T | null {
  const cached = requestCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > CACHE_TTL) {
    requestCache.delete(key);
    return null;
  }

  return cached.data as T;
}

function setCachedData<T>(key: string, data: T): void {
  requestCache.set(key, {
    data,
    timestamp: Date.now(),
  });
}

// Timeout helper — abort fetch after N ms
function fetchWithTimeout(url: string, config: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...config, signal: controller.signal }).finally(() => clearTimeout(id));
}

export const apiClient = {
  async fetch<T = unknown>(
    url: string,
    options: ApiClientOptions = {}
  ): Promise<T> {
    const { skipAuth, skipRetry, useCache = false, ...fetchOptions } = options;

    const method = options.method || 'GET';
    if (useCache && method === 'GET') {
      const cacheKey = getCacheKey(url, options);
      const cachedData = getCachedData<T>(cacheKey);
      if (cachedData) {
        return cachedData;
      }
    }

    // CDC §10.2 : la session voyage par cookies HttpOnly, jamais par un jeton lu en JS.

    const config: RequestInit = {
      cache: 'no-store',
      ...fetchOptions,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    };

    // ai-suggestions can take 60s (Gemini on long docs), dashboard/home 15s, mutations 20s, reads 15s
    const isDashboard = url.includes('/api/dashboard');
    const isHomeSummary = url.includes('/api/home/summary');
    const isAiSuggestions = url.includes('/ai-suggestions');
    const timeoutMs = isAiSuggestions ? 90_000 : (isDashboard || isHomeSummary) ? 15_000 : method === 'GET' ? 15_000 : 20_000;

    try {
      const response = await fetchWithTimeout(url, config, timeoutMs);

      if ((response.status === 401 || response.status === 403) && !skipRetry && !skipAuth) {
        // Try refresh for both 401 (expired token) and 403 with INSUFFICIENT_PERMISSIONS
        // (stale role in JWT — refresh reads fresh role from DB)
        const errorBody = await response.clone().json().catch(() => ({})) as any;
        const isStaleRole = response.status === 403 && (
          errorBody.error === 'INSUFFICIENT_PERMISSIONS' || errorBody.code === 'INSUFFICIENT_PERMISSIONS'
        );
        if (response.status === 401 || isStaleRole) {
          const refreshed = await this.refreshToken();
          if (refreshed === true) {
            return this.fetch<T>(url, { ...options, skipRetry: true });
          }
          // Server error during refresh — don't log out, bubble up the original error
          if (refreshed === 'server_error') {
            throw new ApiClientError(503, 'SERVICE_UNAVAILABLE' as any, {}, undefined, 'Service temporairement indisponible');
          }
          this.handleAuthFailure();
          throw new ApiClientError(response.status, 'UNAUTHORIZED', {}, undefined);
        } else {
          throw new ApiClientError(
            response.status,
            errorBody.code ?? errorBody.error ?? 'FORBIDDEN',
            errorBody.details,
            errorBody.requestId,
            errorBody.message ?? errorBody.error
          );
        }
      }

      if (!response.ok) {
        const errorData: ApiError = await response.json().catch(() => ({
          error: 'Unknown error',
          code: 'UNKNOWN_ERROR',
          message: response.statusText,
        }));

        throw new ApiClientError(
          response.status,
          errorData.code ?? errorData.error ?? 'UNKNOWN_ERROR',
          errorData.details,
          errorData.requestId,
          errorData.message ?? errorData.error
        );
      }

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await response.json();

        if (useCache && method === 'GET') {
          const cacheKey = getCacheKey(url, options);
          setCachedData(cacheKey, data);
        }

        return data;
      }

      return response as T;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }

      // Timeout or network error on GET → retry once after short delay
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isNetwork = error instanceof TypeError && error.message.includes('fetch');
      if ((isAbort || isNetwork) && method === 'GET' && !skipRetry) {
        await new Promise(r => setTimeout(r, 800));
        return this.fetch<T>(url, { ...options, skipRetry: true });
      }

      throw new ApiClientError(
        0,
        isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        { originalError: String(error) },
        undefined,
        isAbort ? 'Délai de connexion dépassé. Vérifiez votre réseau.' : 'Erreur réseau. Vérifiez votre connexion.'
      );
    }
  },

  async refreshToken(): Promise<boolean | 'server_error'> {
    try {
      // Le jeton de renouvellement vit dans un cookie HttpOnly : le serveur
      // le lit lui-meme, le front n'a rien a transmettre (CDC §7.2).
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // Server error (5xx / 503) — don't treat as auth failure, could be transient
      if (response.status >= 500 || response.status === 503) {
        return 'server_error';
      }

      if (response.ok) {
        const data = await response.json();

        if (data.accessToken) {
        }
        if (data.refreshToken) {
        }

        return true;
      }

      return false;
    } catch {
      // Network error — treat as transient server error, don't log out
      return 'server_error';
    }
  },

  handleAuthFailure() {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }

    requestCache.clear();
  },

  get<T = unknown>(url: string, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, { ...options, method: 'GET' });
  },

  post<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  put<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  patch<T = unknown>(url: string, data?: unknown, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  },

  delete<T = unknown>(url: string, options?: ApiClientOptions): Promise<T> {
    return this.fetch<T>(url, { ...options, method: 'DELETE' });
  },

  clearCache(): void {
    requestCache.clear();
  },

  invalidateCache(url: string): void {
    requestCache.delete(`GET:${url}`);
  },
};

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Une erreur est survenue';
}

export { ApiClientError };
