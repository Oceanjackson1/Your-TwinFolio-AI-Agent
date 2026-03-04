import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { getDb } from '../db';
import { getLlm } from './ai';

export interface ConversationScope {
    scopeKey: string;
    ownerUserId: number;
    participantUserId: number;
    partitionId: number | null;
    chatType: 'private' | 'group';
    chatId?: number | undefined;
}

interface StoredMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
}

function toConversationTranscript(messages: StoredMessage[]) {
    return messages
        .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
        .join('\n');
}

function extractJsonObject(raw: string) {
    const fenced = raw.replace(/```json|```/gi, '').trim();
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
        throw new Error('No JSON object found in memory response.');
    }

    return JSON.parse(fenced.slice(start, end + 1));
}

async function ensureConversationScope(scope: ConversationScope) {
    const db = getDb();
    await db.run(
        `INSERT OR IGNORE INTO ConversationScopes
         (scopeKey, ownerUserId, participantUserId, partitionId, chatType, chatId, profile, summary)
         VALUES (?, ?, ?, ?, ?, ?, '', '')`,
        [
            scope.scopeKey,
            scope.ownerUserId,
            scope.participantUserId,
            scope.partitionId,
            scope.chatType,
            scope.chatId ?? null,
        ]
    );

    await db.run(
        `UPDATE ConversationScopes
         SET ownerUserId = ?, participantUserId = ?, partitionId = ?, chatType = ?, chatId = ?, updatedAt = datetime('now')
         WHERE scopeKey = ?`,
        [
            scope.ownerUserId,
            scope.participantUserId,
            scope.partitionId,
            scope.chatType,
            scope.chatId ?? null,
            scope.scopeKey,
        ]
    );
}

export async function getConversationMemory(scope: ConversationScope) {
    const db = getDb();
    await ensureConversationScope(scope);

    const scopeRow = await db.get(
        'SELECT profile, summary FROM ConversationScopes WHERE scopeKey = ?',
        [scope.scopeKey]
    );
    const recentMessages = await db.all(
        `SELECT role, content, createdAt
         FROM ConversationMessages
         WHERE scopeKey = ?
         ORDER BY id DESC
         LIMIT 8`,
        [scope.scopeKey]
    ) as StoredMessage[];

    return {
        profile: scopeRow?.profile || '',
        summary: scopeRow?.summary || '',
        recentMessages: recentMessages.reverse(),
    };
}

export async function saveConversationTurn(
    scope: ConversationScope,
    userMessage: string,
    assistantMessage: string
) {
    const db = getDb();
    await ensureConversationScope(scope);

    await db.run(
        'INSERT INTO ConversationMessages (scopeKey, role, content) VALUES (?, ?, ?)',
        [scope.scopeKey, 'user', userMessage]
    );
    await db.run(
        'INSERT INTO ConversationMessages (scopeKey, role, content) VALUES (?, ?, ?)',
        [scope.scopeKey, 'assistant', assistantMessage]
    );

    await db.run(
        `DELETE FROM ConversationMessages
         WHERE scopeKey = ?
           AND id NOT IN (
             SELECT id FROM ConversationMessages
             WHERE scopeKey = ?
             ORDER BY id DESC
             LIMIT 40
           )`,
        [scope.scopeKey, scope.scopeKey]
    );
}

export async function refreshConversationMemory(scope: ConversationScope) {
    const db = getDb();
    await ensureConversationScope(scope);

    const current = await getConversationMemory(scope);
    if (current.recentMessages.length === 0) {
        return;
    }

    const prompt = PromptTemplate.fromTemplate(`
You maintain long-term memory for a chat between a user and an AI book.

Update two memory fields using the existing memory and the recent conversation.

Rules:
- "profile" only stores stable facts or preferences about the human user.
- "summary" stores durable conversation state, open loops, recent goals, and useful continuity notes.
- Do not invent facts.
- Keep each field under 120 words.
- Return valid JSON only with keys "profile" and "summary".

Existing profile:
{profile}

Existing summary:
{summary}

Recent conversation:
{conversation}
`);

    const chain = prompt.pipe(getLlm()).pipe(new StringOutputParser());

    try {
        const raw = await chain.invoke({
            profile: current.profile || 'None.',
            summary: current.summary || 'None.',
            conversation: toConversationTranscript(current.recentMessages),
        });
        const parsed = extractJsonObject(raw);

        await db.run(
            `UPDATE ConversationScopes
             SET profile = ?, summary = ?, updatedAt = datetime('now')
             WHERE scopeKey = ?`,
            [
                typeof parsed.profile === 'string' ? parsed.profile.trim() : current.profile,
                typeof parsed.summary === 'string' ? parsed.summary.trim() : current.summary,
                scope.scopeKey,
            ]
        );
    } catch (error) {
        console.error('Failed to refresh conversation memory:', error);
    }
}
