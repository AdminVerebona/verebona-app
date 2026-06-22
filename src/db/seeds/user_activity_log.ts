import { db } from '@/db';
import { userActivityLog } from '@/db/schema';

async function main() {
    const sampleActivityLogs = [
        // LOGIN_SUCCESS entries (8 total)
        {
            timestamp: new Date('2024-12-15T09:23:15.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Chrome", "os": "Windows 10"}',
            createdAt: new Date('2024-12-15T09:23:15.000Z'),
        },
        {
            timestamp: new Date('2024-12-18T14:45:32.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Safari", "os": "macOS Sonoma"}',
            createdAt: new Date('2024-12-18T14:45:32.000Z'),
        },
        {
            timestamp: new Date('2024-12-20T08:12:07.000Z'),
            userId: 21,
            userEmail: 'admin@verebona.com',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '192.168.0.103',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Firefox", "os": "Windows 11"}',
            createdAt: new Date('2024-12-20T08:12:07.000Z'),
        },
        {
            timestamp: new Date('2024-12-22T16:34:21.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '172.16.5.42',
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            details: '{"loginMethod": "email_password", "deviceType": "mobile", "browser": "Safari", "os": "iOS 17"}',
            createdAt: new Date('2024-12-22T16:34:21.000Z'),
        },
        {
            timestamp: new Date('2024-12-23T10:05:18.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Safari", "os": "macOS Sonoma"}',
            createdAt: new Date('2024-12-23T10:05:18.000Z'),
        },
        {
            timestamp: new Date('2024-12-24T13:42:55.000Z'),
            userId: 21,
            userEmail: 'admin@verebona.com',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '192.168.1.201',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Edge", "os": "Windows 11"}',
            createdAt: new Date('2024-12-24T13:42:55.000Z'),
        },
        {
            timestamp: new Date('2024-12-26T09:17:33.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Chrome", "os": "Windows 10"}',
            createdAt: new Date('2024-12-26T09:17:33.000Z'),
        },
        {
            timestamp: new Date('2024-12-27T15:28:47.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'LOGIN_SUCCESS' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"loginMethod": "email_password", "deviceType": "desktop", "browser": "Safari", "os": "macOS Sonoma"}',
            createdAt: new Date('2024-12-27T15:28:47.000Z'),
        },

        // LOGIN_FAILED entries (4 total)
        {
            timestamp: new Date('2024-12-16T11:32:41.000Z'),
            userId: null,
            userEmail: 'unknown.user@example.com',
            activityType: 'LOGIN_FAILED' as const,
            ipAddress: '203.0.113.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"reason": "user_not_found", "attemptCount": 1, "accountStatus": "unknown"}',
            createdAt: new Date('2024-12-16T11:32:41.000Z'),
        },
        {
            timestamp: new Date('2024-12-19T08:15:22.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'LOGIN_FAILED' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"reason": "invalid_password", "attemptCount": 2, "accountStatus": "active"}',
            createdAt: new Date('2024-12-19T08:15:22.000Z'),
        },
        {
            timestamp: new Date('2024-12-21T22:47:18.000Z'),
            userId: null,
            userEmail: 'hacker@suspicious.com',
            activityType: 'LOGIN_FAILED' as const,
            ipAddress: '198.51.100.78',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            details: '{"reason": "user_not_found", "attemptCount": 5, "accountStatus": "unknown"}',
            createdAt: new Date('2024-12-21T22:47:18.000Z'),
        },
        {
            timestamp: new Date('2024-12-25T03:12:09.000Z'),
            userId: 21,
            userEmail: 'admin@verebona.com',
            activityType: 'LOGIN_FAILED' as const,
            ipAddress: '192.168.1.201',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            details: '{"reason": "invalid_password", "attemptCount": 1, "accountStatus": "active"}',
            createdAt: new Date('2024-12-25T03:12:09.000Z'),
        },

        // EMAIL_CHANGE entries (2 total)
        {
            timestamp: new Date('2024-12-17T14:22:35.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'EMAIL_CHANGE' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"oldEmail": "geoffroy.old@hotmail.com", "newEmail": "maupiliergeoffroy@hotmail.com", "verificationStatus": "completed"}',
            createdAt: new Date('2024-12-17T14:22:35.000Z'),
        },
        {
            timestamp: new Date('2024-12-24T10:38:12.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'EMAIL_CHANGE' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"oldEmail": "admin.old@owntrack.fr", "newEmail": "admin@owntrack.fr", "verificationStatus": "pending"}',
            createdAt: new Date('2024-12-24T10:38:12.000Z'),
        },

        // PROFILE_UPDATE entries (3 total)
        {
            timestamp: new Date('2024-12-18T11:15:44.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'PROFILE_UPDATE' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"updatedFields": ["firstName", "lastName"], "oldValues": {"firstName": "Geoff", "lastName": "Maupilier"}, "newValues": {"firstName": "Geoffroy", "lastName": "Maupilier-Durand"}}',
            createdAt: new Date('2024-12-18T11:15:44.000Z'),
        },
        {
            timestamp: new Date('2024-12-22T09:42:18.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'PROFILE_UPDATE' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"updatedFields": ["company", "locale"], "oldValues": {"company": "OwnTrack SAS", "locale": "en-US"}, "newValues": {"company": "OwnTrack Technologies", "locale": "fr-FR"}}',
            createdAt: new Date('2024-12-22T09:42:18.000Z'),
        },
        {
            timestamp: new Date('2024-12-26T16:55:33.000Z'),
            userId: 21,
            userEmail: 'admin@verebona.com',
            activityType: 'PROFILE_UPDATE' as const,
            ipAddress: '192.168.1.201',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
            details: '{"updatedFields": ["firstName"], "oldValues": {"firstName": "Admin"}, "newValues": {"firstName": "Alexandre"}}',
            createdAt: new Date('2024-12-26T16:55:33.000Z'),
        },

        // PASSWORD_CHANGE entries (2 total)
        {
            timestamp: new Date('2024-12-20T15:27:51.000Z'),
            userId: 8,
            userEmail: 'admin@owntrack.fr',
            activityType: 'PASSWORD_CHANGE' as const,
            ipAddress: '10.0.2.18',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            details: '{"reason": "user_requested", "strengthScore": 92, "changeSource": "settings_page"}',
            createdAt: new Date('2024-12-20T15:27:51.000Z'),
        },
        {
            timestamp: new Date('2024-12-23T12:08:14.000Z'),
            userId: 21,
            userEmail: 'admin@verebona.com',
            activityType: 'PASSWORD_CHANGE' as const,
            ipAddress: '192.168.1.201',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            details: '{"reason": "admin_reset", "strengthScore": 85, "changeSource": "admin_panel"}',
            createdAt: new Date('2024-12-23T12:08:14.000Z'),
        },

        // SERVER_ERROR entry (1 total)
        {
            timestamp: new Date('2024-12-21T14:33:27.000Z'),
            userId: 7,
            userEmail: 'maupiliergeoffroy@hotmail.com',
            activityType: 'SERVER_ERROR' as const,
            ipAddress: '192.168.1.45',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            details: '{"errorType": "DatabaseConnectionError", "endpoint": "/api/assets", "httpStatus": 500, "errorMessage": "Connection timeout after 30s", "stackTrace": "Error: Connection timeout\\n    at Database.connect (db.ts:45)\\n    at assetsRoute (routes/assets.ts:12)"}',
            createdAt: new Date('2024-12-21T14:33:27.000Z'),
        },
    ];

    await db.insert(userActivityLog).values(sampleActivityLogs);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});