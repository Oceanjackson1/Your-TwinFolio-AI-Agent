import fetch from 'node-fetch';
const pdfParseModule = require('pdf-parse');
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { embeddings } from './ai';
import { extractTextFromImages, OcrPassName, OcrProgressEvent } from './ocrManager';
import * as fs from 'fs';
import * as path from 'path';

interface StoredChunk {
    pageContent: string;
    metadata?: Record<string, any>;
}

export interface PdfParseProgressEvent {
    stage:
    | 'extracting_text'
    | 'rendering_pages'
    | 'ocr_initializing'
    | 'ocr_page_start'
    | 'ocr_progress'
    | 'ocr_page_complete'
    | 'ocr_complete';
    pageNumber?: number | undefined;
    totalPages?: number | undefined;
    passName?: OcrPassName | undefined;
    progress?: number | undefined;
    confidence?: number | undefined;
    textLength?: number | undefined;
    status?: string | undefined;
}

interface ParsePdfOptions {
    onProgress?: ((event: PdfParseProgressEvent) => Promise<void> | void) | undefined;
}

const APP_DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '../../data');
const VECTOR_STORE_DIR = process.env.VECTOR_STORE_DIR
    ? path.resolve(process.env.VECTOR_STORE_DIR)
    : path.join(APP_DATA_DIR, 'vector_stores');

if (!fs.existsSync(VECTOR_STORE_DIR)) {
    fs.mkdirSync(VECTOR_STORE_DIR, { recursive: true });
}

export async function downloadFile(fileUrl: string): Promise<Buffer> {
    const response = await fetch(fileUrl);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

async function emitParseProgress(
    onProgress: ParsePdfOptions['onProgress'],
    event: PdfParseProgressEvent
) {
    if (onProgress) {
        await onProgress(event);
    }
}

function mapOcrProgressToPdfProgress(event: OcrProgressEvent): PdfParseProgressEvent {
    return {
        stage: event.stage,
        pageNumber: event.pageNumber,
        totalPages: event.totalPages,
        passName: event.passName,
        progress: event.progress,
        confidence: event.confidence,
        textLength: event.textLength,
        status: event.status,
    };
}

export async function parsePdfToText(buffer: Buffer, options: ParsePdfOptions = {}): Promise<string> {
    const { onProgress } = options;
    const PDFParse = (pdfParseModule as any).PDFParse;
    const legacyPdfParse =
        typeof pdfParseModule === 'function'
            ? pdfParseModule
            : typeof (pdfParseModule as any).default === 'function'
                ? (pdfParseModule as any).default
                : null;

    if (typeof PDFParse === 'function') {
        const parser = new PDFParse({ data: buffer });
        try {
            await emitParseProgress(onProgress, { stage: 'extracting_text' });
            const result = await parser.getText();
            const extractedText = result.text || '';
            const shouldKeepExtractedText = hasMeaningfulPdfText(extractedText);

            if (shouldKeepExtractedText) {
                return extractedText;
            }

            try {
                await emitParseProgress(onProgress, { stage: 'rendering_pages' });
                const screenshots = await parser.getScreenshot({ desiredWidth: 2200 });
                const ocrText = await extractTextFromImages(
                    screenshots.pages.map((page: any) => Buffer.from(page.data)),
                    {
                        onProgress: async (event) => {
                            await emitParseProgress(onProgress, mapOcrProgressToPdfProgress(event));
                        },
                    }
                );

                return [shouldKeepExtractedText ? extractedText : '', ocrText]
                    .map((value) => value.trim())
                    .filter(Boolean)
                    .join('\n\n')
                    .trim();
            } catch (ocrError) {
                console.error('[pdf] OCR fallback failed:', ocrError);
                if (extractedText.trim()) {
                    return extractedText;
                }
                throw ocrError;
            }
        } finally {
            await parser.destroy?.();
        }
    }

    if (typeof legacyPdfParse === 'function') {
        const data = await legacyPdfParse(buffer);
        return data.text;
    }

    throw new Error('Unsupported pdf-parse module export shape.');
}

function extractSearchTokens(text: string) {
    const normalized = text.toLowerCase();
    const latinTokens = normalized.match(/[a-z0-9]{2,}/g) || [];
    const hanChars = Array.from(normalized.matchAll(/[\p{Script=Han}]/gu), (match) => match[0]);
    const hanBigrams = hanChars.slice(0, -1).map((char, index) => `${char}${hanChars[index + 1]}`);
    return Array.from(new Set([...latinTokens, ...hanChars, ...hanBigrams]));
}

function normalizeExtractedText(text: string) {
    return text
        .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreChunk(query: string, chunkText: string) {
    const normalizedQuery = query.toLowerCase().trim();
    const normalizedChunk = chunkText.toLowerCase();
    const tokens = extractSearchTokens(query);

    if (!normalizedChunk) {
        return 0;
    }

    let score = 0;

    if (normalizedQuery && normalizedChunk.includes(normalizedQuery)) {
        score += 12;
    }

    for (const token of tokens) {
        if (normalizedChunk.includes(token)) {
            score += token.length > 2 ? 3 : 1;
        }
    }

    return score;
}

function getDocstorePath(partitionId: number) {
    return path.join(VECTOR_STORE_DIR, `partition_${partitionId}`, 'docstore.json');
}

export function hasMeaningfulPdfText(text: string): boolean {
    const normalized = normalizeExtractedText(text);
    const searchableChars = normalized.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '');
    return searchableChars.length >= 20;
}

export async function processAndStoreDocument(
    partitionId: number,
    text: string,
    metadata: { fileId: string, fileName: string }
) {
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
    });

    const docs = await splitter.createDocuments([text], [metadata]);

    const storePath = path.join(VECTOR_STORE_DIR, `partition_${partitionId}`);

    let vectorStore: HNSWLib;

    if (fs.existsSync(storePath)) {
        // Load existing
        vectorStore = await HNSWLib.load(storePath, embeddings);
        await vectorStore.addDocuments(docs);
    } else {
        // Create new
        vectorStore = await HNSWLib.fromDocuments(docs, embeddings);
    }

    // Save to disk
    await vectorStore.save(storePath);
}

export async function getStoredChunksForPartition(partitionId: number): Promise<StoredChunk[]> {
    const docstorePath = getDocstorePath(partitionId);

    if (!fs.existsSync(docstorePath)) {
        return [];
    }

    const raw = await fs.promises.readFile(docstorePath, 'utf8');
    const parsed = JSON.parse(raw) as Array<[string, StoredChunk]>;
    return parsed.map((entry) => entry[1]);
}

export async function searchPartitionChunks(
    partitionId: number,
    query: string,
    limit = 3
): Promise<StoredChunk[]> {
    const chunks = await getStoredChunksForPartition(partitionId);

    return chunks
        .map((chunk) => ({
            chunk,
            score: scoreChunk(query, chunk.pageContent),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((entry) => entry.chunk);
}

export async function getVectorStoreForPartition(partitionId: number): Promise<HNSWLib | null> {
    const storePath = path.join(VECTOR_STORE_DIR, `partition_${partitionId}`);
    if (fs.existsSync(storePath)) {
        return await HNSWLib.load(storePath, embeddings);
    }
    return null;
}
