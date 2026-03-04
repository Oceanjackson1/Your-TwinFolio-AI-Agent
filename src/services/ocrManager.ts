const { createWorker, PSM } = require('tesseract.js');
import * as fs from 'fs';
import * as path from 'path';

const OCR_CACHE_DIR = path.join(__dirname, '../../ocr_cache');
const OCR_LANGS = (process.env.OCR_LANGS || 'eng+chi_sim').split('+').filter(Boolean).join('+');
const OCR_WORKER_PATH = require.resolve('tesseract.js/src/worker-script/node/index.js');

if (!fs.existsSync(OCR_CACHE_DIR)) {
    fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
}

export type OcrPassName = 'auto' | 'single_block' | 'sparse_text';

export interface OcrProgressEvent {
    stage: 'ocr_initializing' | 'ocr_page_start' | 'ocr_progress' | 'ocr_page_complete' | 'ocr_complete';
    pageNumber?: number | undefined;
    totalPages?: number | undefined;
    passName?: OcrPassName | undefined;
    progress?: number | undefined;
    confidence?: number | undefined;
    textLength?: number | undefined;
    status?: string | undefined;
}

interface OcrExtractOptions {
    onProgress?: ((event: OcrProgressEvent) => Promise<void> | void) | undefined;
}

interface OcrPassConfig {
    name: OcrPassName;
    psm: string;
}

interface OcrPageResult {
    text: string;
    confidence: number;
    passName: OcrPassName;
    score: number;
}

const OCR_PASSES: OcrPassConfig[] = [
    { name: 'auto', psm: PSM.AUTO },
    { name: 'single_block', psm: PSM.SINGLE_BLOCK },
    { name: 'sparse_text', psm: PSM.SPARSE_TEXT },
];

let workerPromise: Promise<any> | null = null;
let activeProgressHandler: OcrExtractOptions['onProgress'] | null = null;
let activeProgressMeta: { pageNumber: number; totalPages: number; passName: OcrPassName } | null = null;
let lastWorkerProgressFingerprint = '';
let lastWorkerProgressAt = 0;

async function emitProgress(event: OcrProgressEvent, onProgress?: OcrExtractOptions['onProgress']) {
    if (onProgress) {
        await onProgress(event);
    }
}

function shouldEmitWorkerProgress(message: { progress?: number; status?: string }) {
    if (!activeProgressMeta) {
        return false;
    }

    const progress = typeof message.progress === 'number'
        ? Math.min(1, Math.max(0, message.progress))
        : undefined;
    const bucket = typeof progress === 'number'
        ? Math.floor((progress * 100) / 10) * 10
        : -1;
    const status = typeof message.status === 'string' ? message.status : '';
    const fingerprint = [
        activeProgressMeta.pageNumber,
        activeProgressMeta.passName,
        status,
        bucket,
    ].join(':');
    const now = Date.now();

    if (fingerprint === lastWorkerProgressFingerprint && now - lastWorkerProgressAt < 1500) {
        return false;
    }

    lastWorkerProgressFingerprint = fingerprint;
    lastWorkerProgressAt = now;
    return true;
}

function normalizeOcrText(text: string) {
    return text
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getRecognizedCharCount(text: string) {
    return text.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '').length;
}

function scoreOcrResult(text: string, confidence: number) {
    const compactLength = getRecognizedCharCount(text);
    const hasHan = /[\u4e00-\u9fff]/.test(text);
    const hasLatin = /[a-zA-Z]/.test(text);
    const mixedScriptBonus = hasHan && hasLatin ? 12 : 0;

    return confidence + Math.min(compactLength / 6, 40) + mixedScriptBonus;
}

function shouldAcceptEarly(result: OcrPageResult) {
    return result.confidence >= 80 && getRecognizedCharCount(result.text) >= 100;
}

async function getWorker(onProgress?: OcrExtractOptions['onProgress']) {
    activeProgressHandler = onProgress || null;

    if (!workerPromise) {
        workerPromise = (async () => {
            await emitProgress({ stage: 'ocr_initializing' }, activeProgressHandler || undefined);

            const worker = await createWorker(OCR_LANGS, 1, {
                cachePath: OCR_CACHE_DIR,
                workerPath: OCR_WORKER_PATH,
                logger: (message: { progress?: number; status?: string }) => {
                    if (!activeProgressHandler || !activeProgressMeta) {
                        return;
                    }

                    if (!shouldEmitWorkerProgress(message)) {
                        return;
                    }

                    void activeProgressHandler({
                        stage: 'ocr_progress',
                        pageNumber: activeProgressMeta.pageNumber,
                        totalPages: activeProgressMeta.totalPages,
                        passName: activeProgressMeta.passName,
                        progress: typeof message.progress === 'number' ? message.progress : undefined,
                        status: typeof message.status === 'string' ? message.status : undefined,
                    });
                },
                errorHandler: (error: unknown) => {
                    console.error('[ocr] worker error:', error);
                },
            });

            await worker.setParameters({
                preserve_interword_spaces: '1',
                user_defined_dpi: '300',
            });

            return worker;
        })().catch((error) => {
            workerPromise = null;
            throw error;
        });
    }

    return workerPromise;
}

async function recognizePageWithPass(
    worker: any,
    image: Uint8Array | Buffer,
    pass: OcrPassConfig,
    pageNumber: number,
    totalPages: number,
    onProgress?: OcrExtractOptions['onProgress']
): Promise<OcrPageResult> {
    activeProgressMeta = {
        pageNumber,
        totalPages,
        passName: pass.name,
    };
    lastWorkerProgressFingerprint = '';
    lastWorkerProgressAt = 0;

    await worker.setParameters({
        tessedit_pageseg_mode: pass.psm,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
    });

    const { data } = await worker.recognize(Buffer.from(image), {
        rotateAuto: true,
    });

    const text = normalizeOcrText(data?.text || '');
    const confidence = Number(data?.confidence || 0);
    const result = {
        text,
        confidence,
        passName: pass.name,
        score: scoreOcrResult(text, confidence),
    };

    await emitProgress({
        stage: 'ocr_page_complete',
        pageNumber,
        totalPages,
        passName: pass.name,
        confidence,
        textLength: getRecognizedCharCount(text),
    }, onProgress);

    return result;
}

export async function extractTextFromImages(
    images: Array<Uint8Array | Buffer>,
    options: OcrExtractOptions = {}
) {
    const { onProgress } = options;
    const worker = await getWorker(onProgress);
    const pages: string[] = [];
    const totalPages = images.length;

    for (const [index, image] of images.entries()) {
        const pageNumber = index + 1;
        await emitProgress({ stage: 'ocr_page_start', pageNumber, totalPages }, onProgress);

        let bestResult: OcrPageResult | null = null;

        for (const pass of OCR_PASSES) {
            const result = await recognizePageWithPass(worker, image, pass, pageNumber, totalPages, onProgress);
            if (!bestResult || result.score > bestResult.score) {
                bestResult = result;
            }

            if (shouldAcceptEarly(result)) {
                break;
            }
        }

        if (bestResult?.text) {
            pages.push(`-- OCR Page ${pageNumber} --\n${bestResult.text}`);
        }
    }

    activeProgressMeta = null;
    lastWorkerProgressFingerprint = '';
    lastWorkerProgressAt = 0;
    await emitProgress({ stage: 'ocr_complete', totalPages }, onProgress);
    return pages.join('\n\n').trim();
}

export async function shutdownOcrWorker() {
    if (!workerPromise) {
        return;
    }

    const worker = await workerPromise;
    workerPromise = null;
    activeProgressHandler = null;
    activeProgressMeta = null;
    lastWorkerProgressFingerprint = '';
    lastWorkerProgressAt = 0;
    await worker.terminate();
}
