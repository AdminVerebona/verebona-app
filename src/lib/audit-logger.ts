import { db } from '@/db';
import { userActivityLog } from '@/db/schema';
import { NextRequest } from 'next/server';

type ActivityType = 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'EMAIL_CHANGE' | 'PROFILE_UPDATE' | 'PASSWORD_CHANGE' | 'SERVER_ERROR';

interface LogActivityParams {
  activityType: ActivityType;
  userId?: number | null;
  userEmail: string;
  details?: Record<string, any>;
  request?: NextRequest;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log user activity to the audit log
 */
export async function logUserActivity(params: LogActivityParams): Promise<void> {
  try {
    const {
      activityType,
      userId,
      userEmail,
      details,
      request,
      ipAddress: customIpAddress,
      userAgent: customUserAgent,
    } = params;

    // Extract IP and User Agent from request if provided
    let ipAddress = customIpAddress;
    let userAgent = customUserAgent;

    if (request) {
      // Try to get real IP from various headers
      ipAddress = ipAddress || 
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown';
      
      userAgent = userAgent || request.headers.get('user-agent') || 'unknown';
    }

    await db.insert(userActivityLog).values({
      timestamp: new Date(),
      userId: userId || null,
      userEmail,
      activityType,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      details: details ? JSON.stringify(details) : null,
      createdAt: new Date(),
    });

  } catch {
    // Don't throw - logging should never break the main flow
  }
}
