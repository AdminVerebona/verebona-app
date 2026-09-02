/**
 * Standardized API error responses for Verebona
 * Provides consistent error formatting across all endpoints
 */

import { NextResponse } from 'next/server';

export type ErrorCode =
  // Authentication errors
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_INACTIVE'
  
  // Authorization errors
  | 'ACCESS_DENIED'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'NOT_OWNER'
  
  // Validation errors
  | 'INVALID_INPUT'
  | 'MISSING_FIELD'
  | 'INVALID_FORMAT'
  | 'INVALID_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED'
  
  // Resource errors
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'RESOURCE_DELETED'
  
  // Rate limiting & quotas
  | 'RATE_LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'PLAN_LIMIT_REACHED'
  
  // Server errors
  | 'INTERNAL_ERROR'
  | 'INTERNAL_SERVER_ERROR'
  | 'DATABASE_ERROR'
  | 'S3_ERROR'
  | 'EXTERNAL_SERVICE_ERROR'

    // Aliases
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'ACCOUNT_NOT_FOUND'
    // Extended codes
    | 'ASSET_LIMIT_REACHED'
    | 'INVALID_STATE'
    | 'INVALID_ID'
    | 'EVENT_NOT_FOUND'
    | 'ASSET_NOT_FOUND'
    | 'NO_UPDATES'
    | 'PLAN_UPGRADE_REQUIRED'

    // Refus de droits — miroir de `DenialReason` (entitlements.service.ts).
    // Ces codes sont renvoyés tels quels au client : chacun appelle une action
    // différente côté interface (proposer une offre, expliquer un quota,
    // signaler une fin d'essai). Les regrouper sous un code générique ferait
    // perdre cette distinction, que le CDC tarification §8.3 exploite.
    //
    // `PREMIUM_REQUIRED` figurait déjà dans le contrat de fait : trois routes
    // l'émettent (api/account/calendar-token et sa variante toggle), sans
    // passer par apiError, donc sans contrôle de type.
    | 'ASSET_QUOTA_REACHED'
    // Quota déjà franchi — écriture suspendue, lecture et export préservés.
    | 'ASSET_QUOTA_EXCEEDED'
    | 'DOCUMENT_QUOTA_REACHED'
    | 'USER_QUOTA_REACHED'
    | 'PREMIUM_REQUIRED'
    | 'TRIAL_EXPIRED'
    | 'SUBSCRIPTION_REQUIRED';

export interface ApiErrorResponse {
  error: string;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | string;
  timestamp?: string;
}

/**
 * Create a standardized error response
 */
export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown> | string
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      error: message,
      code,
      message,
      details,
      timestamp: new Date().toISOString(),
    },
    { status }
  );
}

/**
 * Predefined error responses for common cases
 */
export const ApiErrors = {
  // 401 Unauthorized
    authRequired: (details?: string) =>
      apiError(401, 'AUTH_REQUIRED', 'Authentication required', details),
    
    invalidToken: (details?: string) =>
      apiError(401, 'INVALID_TOKEN', 'Invalid or malformed token', details),
    
    tokenExpired: (details?: string) =>
      apiError(401, 'TOKEN_EXPIRED', 'Token has expired', details),
    
    invalidCredentials: (details?: string) =>
      apiError(401, 'INVALID_CREDENTIALS', 'Email ou mot de passe incorrect', details),

    unauthorized: (details?: string) =>
      apiError(401, 'UNAUTHORIZED', 'Unauthorized', details),

    // 403 Forbidden
    accountSuspended: (details?: string) =>
      apiError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended', details),
    
    accountInactive: (details?: string) =>
      apiError(403, 'ACCOUNT_INACTIVE', 'Your account is inactive', details),
    
    accessDenied: (details?: string) =>
      apiError(403, 'ACCESS_DENIED', 'Access denied', details),
    
    insufficientPermissions: (details?: string) =>
      apiError(403, 'INSUFFICIENT_PERMISSIONS', 'Insufficient permissions', details),
    
    notOwner: (resource: string) =>
      apiError(403, 'NOT_OWNER', `You are not the owner of this ${resource}`, resource),

    forbidden: (details?: string) =>
      apiError(403, 'ACCESS_DENIED', 'Forbidden', details),

  // 404 Not Found
  notFound: (resource: string) =>
    apiError(404, 'NOT_FOUND', `${resource} not found`, resource),

  // 400 Bad Request
  invalidInput: (details?: string | Record<string, unknown>) =>
    apiError(400, 'INVALID_INPUT', 'Invalid input data', details),
  
  missingField: (field: string) =>
    apiError(400, 'MISSING_FIELD', `Missing required field: ${field}`, field),
  
  invalidFormat: (field: string, expectedFormat?: string) =>
    apiError(400, 'INVALID_FORMAT', `Invalid format for field: ${field}`, expectedFormat),
  
  alreadyExists: (resource: string) =>
    apiError(400, 'ALREADY_EXISTS', `${resource} already exists`, resource),

  resourceDeleted: (resource: string) =>
    apiError(400, 'RESOURCE_DELETED', `${resource} has been deleted`, resource),

  // 413 Payload Too Large
  fileTooLarge: (maxSize: string) =>
    apiError(413, 'FILE_TOO_LARGE', `File exceeds maximum size of ${maxSize}`, maxSize),

  // 415 Unsupported Media Type
  invalidFileType: (allowedTypes: string[]) =>
    apiError(415, 'INVALID_FILE_TYPE', 'Invalid file type', { allowedTypes }),

  // 429 Too Many Requests
  rateLimitExceeded: (details?: string) =>
    apiError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', details),
  
  quotaExceeded: (resource: string) =>
    apiError(429, 'QUOTA_EXCEEDED', `${resource} quota exceeded`, resource),
  
  planLimitReached: (planType: string, limit: number) =>
    apiError(429, 'PLAN_LIMIT_REACHED', `Plan limit reached for ${planType}`, { planType, limit }),

  // 500 Internal Server Error
  internalError: (details?: string) =>
    apiError(500, 'INTERNAL_ERROR', 'Internal server error', details),
  
  databaseError: (details?: string) =>
    apiError(500, 'DATABASE_ERROR', 'Database error', details),
  
  s3Error: (details?: string) =>
    apiError(500, 'S3_ERROR', 'File storage error', details),
  
  externalServiceError: (service: string, details?: string) =>
    apiError(500, 'EXTERNAL_SERVICE_ERROR', `External service error: ${service}`, details),
};