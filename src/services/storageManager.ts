import * as fs from 'fs';
import * as path from 'path';

const APP_DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '../../data');
const LOCAL_UPLOADS_DIR = path.join(APP_DATA_DIR, 'uploads');
const AGENT_ID = process.env.AGENT_ID || 'polymarket-ai-agent';

type StorageType = 'local' | 'cos';

export interface StoredFileResult {
    storageType: StorageType;
    localPath: string;
    storageUrl: string | null;
    objectKey: string | null;
}

interface PersistPdfInput {
    buffer: Buffer;
    originalFileName: string;
    partitionId: number;
    userId: number;
}

function hasCosConfig() {
    return Boolean(
        process.env.COS_BUCKET &&
        process.env.COS_REGION &&
        process.env.COS_SECRET_ID &&
        process.env.COS_SECRET_KEY
    );
}

function safeFileName(fileName: string) {
    const trimmed = (fileName || 'document.pdf').trim();
    const fallback = trimmed.length > 0 ? trimmed : 'document.pdf';
    return fallback.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensurePdfExtension(fileName: string) {
    return fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
}

function buildObjectKey(fileName: string, partitionId: number, userId: number) {
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const ts = String(now.getTime());
    const rand = Math.random().toString(36).slice(2, 8);
    return `agents/${AGENT_ID}/pdf/${yyyy}/${mm}/${dd}/u${userId}_p${partitionId}_${ts}_${rand}_${fileName}`;
}

function buildLocalRelativePath(fileName: string, partitionId: number, userId: number) {
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const ts = String(now.getTime());
    const rand = Math.random().toString(36).slice(2, 8);
    return path.join(
        AGENT_ID,
        'pdf',
        yyyy,
        mm,
        dd,
        `u${userId}_p${partitionId}_${ts}_${rand}_${fileName}`
    );
}

function uploadToCos(key: string, buffer: Buffer): Promise<string> {
    const COS: any = require('cos-nodejs-sdk-v5');
    const cos = new COS({
        SecretId: process.env.COS_SECRET_ID,
        SecretKey: process.env.COS_SECRET_KEY,
    });

    const bucket = process.env.COS_BUCKET as string;
    const region = process.env.COS_REGION as string;
    const customBase = process.env.COS_BASE_URL;

    return new Promise((resolve, reject) => {
        cos.putObject(
            {
                Bucket: bucket,
                Region: region,
                Key: key,
                Body: buffer,
                ContentType: 'application/pdf',
            },
            (err: any) => {
                if (err) {
                    reject(err);
                    return;
                }

                const normalizedBase = customBase
                    ? customBase.replace(/\/+$/, '')
                    : `https://${bucket}.cos.${region}.myqcloud.com`;
                resolve(`${normalizedBase}/${key}`);
            }
        );
    });
}

export async function persistPdfArtifact(input: PersistPdfInput): Promise<StoredFileResult> {
    const safeName = ensurePdfExtension(safeFileName(input.originalFileName));
    const localRelative = buildLocalRelativePath(safeName, input.partitionId, input.userId);
    const localAbsolute = path.join(LOCAL_UPLOADS_DIR, localRelative);
    const localDir = path.dirname(localAbsolute);
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(localAbsolute, input.buffer);

    if (!hasCosConfig()) {
        return {
            storageType: 'local',
            localPath: localAbsolute,
            storageUrl: null,
            objectKey: null,
        };
    }

    const key = buildObjectKey(safeName, input.partitionId, input.userId);

    try {
        const storageUrl = await uploadToCos(key, input.buffer);
        return {
            storageType: 'cos',
            localPath: localAbsolute,
            storageUrl,
            objectKey: key,
        };
    } catch (error) {
        // Fallback to local storage to avoid blocking ingestion when COS is transiently unavailable.
        console.error('[storage] COS upload failed, fallback to local:', error);
        return {
            storageType: 'local',
            localPath: localAbsolute,
            storageUrl: null,
            objectKey: null,
        };
    }
}

export function getStorageSummary() {
    if (!hasCosConfig()) {
        return 'local';
    }
    return `cos:${process.env.COS_BUCKET || 'unknown'}@${process.env.COS_REGION || 'unknown'}`;
}

