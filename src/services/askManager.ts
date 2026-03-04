import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { MyContext } from '../bot';
import {
    getPartitionById,
    getPartitionSettings,
    getUser,
    getUserPartitions,
    GroupBindingSettings,
    Partition,
    PartitionSettings,
} from '../db/services';
import { getLlm } from './ai';
import {
    ConversationScope,
    getConversationMemory,
    refreshConversationMemory,
    saveConversationTurn,
} from './memoryManager';
import { searchPartitionChunks } from './pdfManager';

interface AskAiOptions {
    targetUserId?: number | undefined;
    partitionId?: number | undefined;
    chatType?: 'private' | 'group';
    chatId?: number | undefined;
    settingsOverride?: Partial<Pick<GroupBindingSettings, 'replyStyle' | 'knowledgeMode' | 'citationMode'>> | undefined;
}

function getQuestionModeInstruction(mode: PartitionSettings['questionMode']) {
    if (mode === 'clarify-first') {
        return 'If the request is ambiguous or under-specified, ask one short clarifying question before answering.';
    }

    if (mode === 'answer-first') {
        return 'Give the best possible answer directly. If details are missing, state the uncertainty briefly and continue.';
    }

    return 'Answer directly when possible. Ask a clarifying question only when it is genuinely necessary.';
}

function getReplyStyleInstruction(style: PartitionSettings['replyStyle']) {
    if (style === 'concise') {
        return 'Prefer concise, compact answers with only the necessary detail.';
    }

    if (style === 'detailed') {
        return 'Prefer comprehensive, structured answers with useful detail and explanation.';
    }

    return 'Use a balanced reply style: clear, practical, and moderately detailed.';
}

function getKnowledgeInstruction(mode: PartitionSettings['knowledgeMode']) {
    if (mode === 'strict') {
        return 'Use only the uploaded document context and conversation memory. If the answer is not supported, say so clearly instead of guessing.';
    }

    return 'Prioritize the uploaded document context. If it is incomplete, you may use general knowledge, but clearly distinguish that from document-backed information.';
}

function getCitationInstruction(citationMode: number) {
    if (!citationMode) {
        return 'Do not add a Sources section.';
    }

    return 'If you use the uploaded document context, end with a short "Sources:" line that lists the relevant file names.';
}

function normalizePlainTextResponse(response: string) {
    return response
        .replace(/\r/g, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2')
        .replace(/```([\s\S]*?)```/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^\*\s+/gm, '• ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildScopeKey(scope: ConversationScope) {
    const partitionSegment = scope.partitionId ?? 'all';

    if (scope.chatType === 'group') {
        return `group:${scope.chatId}:owner:${scope.ownerUserId}:participant:${scope.participantUserId}:partition:${partitionSegment}`;
    }

    return `private:owner:${scope.ownerUserId}:participant:${scope.participantUserId}:partition:${partitionSegment}`;
}

async function resolveTargetPartitions(targetUserId: number, partitionId?: number): Promise<Partition[]> {
    if (partitionId) {
        const requestedPartition = await getPartitionById(targetUserId, partitionId);
        return requestedPartition ? [requestedPartition] : [];
    }

    const owner = await getUser(targetUserId);

    if (owner?.activePartitionId) {
        const activePartition = await getPartitionById(targetUserId, owner.activePartitionId);
        if (activePartition) {
            return [activePartition];
        }
    }

    return await getUserPartitions(targetUserId) as Partition[];
}

async function resolvePartitionSettings(partitions: Partition[]) {
    const firstPartition = partitions[0];
    if (!firstPartition) {
        return null;
    }

    return await getPartitionSettings(firstPartition.id);
}

function mergeRuntimeSettings(
    partitionSettings: PartitionSettings | null,
    settingsOverride: AskAiOptions['settingsOverride']
): PartitionSettings | null {
    if (!partitionSettings) {
        return null;
    }

    return {
        ...partitionSettings,
        ...(settingsOverride || {}),
    };
}

export async function askAiWithContext(
    ctx: MyContext,
    question: string,
    options: AskAiOptions = {}
) {
    if (!ctx.from) {
        return 'Error';
    }

    const ownerUserId = options.targetUserId || ctx.from.id;
    const participantUserId = ctx.from.id;
    const targetPartitions = await resolveTargetPartitions(ownerUserId, options.partitionId);
    const partitionSettings = mergeRuntimeSettings(
        await resolvePartitionSettings(targetPartitions),
        options.settingsOverride
    );

    const retrievedChunks = [];
    for (const partition of targetPartitions) {
        const matches = await searchPartitionChunks(partition.id, question, 3);
        for (const match of matches) {
            retrievedChunks.push({
                partition,
                pageContent: match.pageContent,
                metadata: match.metadata || {},
            });
        }
    }

    const contextText = retrievedChunks
        .map((chunk) => {
            const source = chunk.metadata.fileName || chunk.partition.name;
            return `[Source: ${source} | Partition: ${chunk.partition.name}]\n${chunk.pageContent}`;
        })
        .join('\n\n');

    const sourceList = Array.from(
        new Set(
            retrievedChunks
                .map((chunk) => chunk.metadata.fileName || chunk.partition.name)
                .filter(Boolean)
        )
    );

    const scope: ConversationScope = {
        scopeKey: '',
        ownerUserId,
        participantUserId,
        partitionId: targetPartitions[0]?.id ?? null,
        chatType: options.chatType || 'private',
        chatId: options.chatId,
    };
    scope.scopeKey = buildScopeKey(scope);

    const memory = await getConversationMemory(scope);

    const promptTemplate = PromptTemplate.fromTemplate(`
You are Consultant, an AI digital twin that answers on behalf of a real person's Book.

Conversation channel: {channelInstruction}

Book partition: {partitionName}

Persona instructions:
{personaPrompt}

Question handling mode:
{questionModeInstruction}

Reply style:
{replyStyleInstruction}

Knowledge policy:
{knowledgeInstruction}

Citation policy:
{citationInstruction}

Long-term user profile memory:
{profileMemory}

Conversation continuity summary:
{conversationSummary}

Recent conversation history:
{conversationHistory}

Relevant context from uploaded documents:
<context>
{context}
</context>

Available source labels:
{sourceList}

User question:
{question}

Reply in the user's preferred language: {language}.

Additional rules:
- If there is no useful document context, do not pretend there is.
- Keep the answer grounded, specific, and aligned with the configured persona.
- If memory contains useful user preferences or history, use it naturally.
- Return plain text only.
- Do not use Markdown formatting such as ## headings, **bold**, code fences, inline backticks, or markdown links.
- If you need structure, use short plain sentences or simple numbered lists.
`);

    const chain = promptTemplate.pipe(getLlm()).pipe(new StringOutputParser());

    const response = await chain.invoke({
        partitionName: targetPartitions[0]?.name || 'Default Book',
        personaPrompt: partitionSettings?.personaPrompt?.trim() || 'No extra persona instruction.',
        questionModeInstruction: getQuestionModeInstruction(partitionSettings?.questionMode || 'auto'),
        replyStyleInstruction: getReplyStyleInstruction(partitionSettings?.replyStyle || 'balanced'),
        knowledgeInstruction: getKnowledgeInstruction(partitionSettings?.knowledgeMode || 'hybrid'),
        citationInstruction: getCitationInstruction(partitionSettings?.citationMode ?? 1),
        profileMemory: memory.profile || 'No stored profile yet.',
        conversationSummary: memory.summary || 'No prior summary yet.',
        conversationHistory: memory.recentMessages.length > 0
            ? memory.recentMessages
                .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
                .join('\n')
            : 'No prior conversation history.',
        context: contextText || 'No relevant document context found.',
        sourceList: sourceList.length > 0 ? sourceList.join(', ') : 'No sources available.',
        question,
        language: ctx.userLang === 'zh' ? 'Chinese' : 'English',
        channelInstruction: (options.chatType || 'private') === 'group'
            ? 'Group chat. Keep answers concise, easy to scan, and avoid unnecessary private-chat style back-and-forth.'
            : 'Private chat. You can be more direct and personalized while staying grounded in the configured knowledge.',
    });
    const cleanedResponse = normalizePlainTextResponse(response);

    await saveConversationTurn(scope, question, cleanedResponse);
    await refreshConversationMemory(scope);

    return cleanedResponse;
}
