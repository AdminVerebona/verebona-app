/**
 * Structured logging for file operations
 * Format: JSON with timestamp, requestId, ip, userAgent, userId, assetId, fileId, action, status
 */

export interface FileLogData {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  userId: number;
  assetId?: number;
  fileId?: number;
  filename?: string;
  action: 'PRESIGN_REQUEST' | 'UPLOAD_CONFIRM' | 'DOWNLOAD' | 'DELETE' | 'QUOTA_CHECK' | 'ERROR' | 'VIEW';
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'RATE_LIMITED';
  error?: string;
  details?: Record<string, unknown>;
}

export class FileLogger {
  static log(data: FileLogData): void {
    const logEntry = {
      timestamp: new Date(),
      ...data,
    };

    // Structure: JSON sur une ligne pour parsing facile
  }

  static error(data: Omit<FileLogData, 'status'> & { error: string }): void {
    this.log({
      ...data,
      status: 'FAILED',
    });
  }

  static success(data: Omit<FileLogData, 'status'>): void {
    this.log({
      ...data,
      status: 'SUCCESS',
    });
  }

  static blocked(data: Omit<FileLogData, 'status'> & { error: string }): void {
    this.log({
      ...data,
      status: 'BLOCKED',
    });
  }

  static rateLimited(data: Omit<FileLogData, 'status'> & { error: string }): void {
    this.log({
      ...data,
      status: 'RATE_LIMITED',
    });
  }
}
