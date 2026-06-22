import { db } from '@/db';
import { systemLogos } from '@/db/schema';

async function main() {
    const sampleLogos = [
        {
            code: 'VEREBONA_WEB',
            label: 'Logo Verebona Web (Animé)',
            description: 'Version web avec animation 3D du cube central',
            logoType: 'WEB_ANIMATED' as const,
            contentType: 'text/html',
            logoContent: `<!DOCTYPE html>
<html>
<head>
    <style>
        .verebona-logo {
            display: inline-grid;
            grid-template-columns: repeat(3, 26.67px);
            grid-template-rows: repeat(3, 26.67px);
            gap: 0;
            width: 80px;
            height: 80px;
            padding: 0;
            margin: 0;
        }
        .verebona-logo .square {
            width: 26.67px;
            height: 26.67px;
            background-color: #2F3941;
        }
        .verebona-logo .square.center {
            background-color: #4A7FE5;
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% {
                transform: scale(1);
                opacity: 1;
            }
            50% {
                transform: scale(0.95);
                opacity: 0.8;
            }
        }
    </style>
</head>
<body>
    <div class="verebona-logo">
        <div class="square"></div>
        <div class="square"></div>
        <div class="square"></div>
        <div class="square"></div>
        <div class="square center"></div>
        <div class="square"></div>
        <div class="square"></div>
        <div class="square"></div>
        <div class="square"></div>
    </div>
</body>
</html>`,
            width: 80,
            height: 80,
            isActive: true,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'VEREBONA_EMAIL',
            label: 'Logo Verebona Email (Statique)',
            description: 'Version email compatible avec clients email (statique)',
            logoType: 'EMAIL_STATIC' as const,
            contentType: 'text/html',
            logoContent: `<!DOCTYPE html>
<html>
<head>
    <style>
        table.verebona-logo-email {
            border-collapse: collapse;
            border-spacing: 0;
            padding: 0;
            margin: 0;
        }
        table.verebona-logo-email td {
            padding: 0;
            margin: 0;
            border: 0;
            width: 26.67px;
            height: 26.67px;
        }
        table.verebona-logo-email td.square-dark {
            background-color: #2F3941;
        }
        table.verebona-logo-email td.square-blue {
            background-color: #4A7FE5;
        }
    </style>
</head>
<body>
    <table class="verebona-logo-email" width="80" height="80" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td class="square-dark" width="26.67" height="26.67"></td>
            <td class="square-dark" width="26.67" height="26.67"></td>
            <td class="square-dark" width="26.67" height="26.67"></td>
        </tr>
        <tr>
            <td class="square-dark" width="26.67" height="26.67"></td>
            <td class="square-blue" width="26.67" height="26.67"></td>
            <td class="square-dark" width="26.67" height="26.67"></td>
        </tr>
        <tr>
            <td class="square-dark" width="26.67" height="26.67"></td>
            <td class="square-dark" width="26.67" height="26.67"></td>
            <td class="square-dark" width="26.67" height="26.67"></td>
        </tr>
    </table>
</body>
</html>`,
            width: 80,
            height: 80,
            isActive: true,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        {
            code: 'VEREBONA_PDF',
            label: 'Logo Verebona PDF',
            description: 'Version pour exports PDF (statique, optimisée)',
            logoType: 'PDF_STATIC' as const,
            contentType: 'text/html',
            logoContent: `<!DOCTYPE html>
<html>
<head>
    <style>
        table.verebona-logo-pdf {
            border-collapse: collapse;
            border-spacing: 0;
            padding: 0;
            margin: 0;
            width: 80px;
            height: 80px;
        }
        table.verebona-logo-pdf td {
            padding: 0;
            margin: 0;
            border: 0;
            width: 26.67px;
            height: 26.67px;
        }
        table.verebona-logo-pdf td.square-dark {
            background-color: #2F3941;
        }
        table.verebona-logo-pdf td.square-blue {
            background-color: #4A7FE5;
        }
    </style>
</head>
<body>
    <table class="verebona-logo-pdf" cellpadding="0" cellspacing="0" border="0">
        <tbody>
            <tr>
                <td class="square-dark"></td>
                <td class="square-dark"></td>
                <td class="square-dark"></td>
            </tr>
            <tr>
                <td class="square-dark"></td>
                <td class="square-blue"></td>
                <td class="square-dark"></td>
            </tr>
            <tr>
                <td class="square-dark"></td>
                <td class="square-dark"></td>
                <td class="square-dark"></td>
            </tr>
        </tbody>
    </table>
</body>
</html>`,
            width: 80,
            height: 80,
            isActive: true,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        }
    ];

    await db.insert(systemLogos).values(sampleLogos);
    
}

main().catch((error) => {
    console.error('❌ Seeder failed:', error);
});