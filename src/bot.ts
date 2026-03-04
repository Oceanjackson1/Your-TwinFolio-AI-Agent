import { Telegraf, Context, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import { initDb } from './db';
import {
    createUser, getUser, subscribeUser, updateUserLanguage, addDocument,
    setInviteCode, getInviteCode, resolveInviteCode,
    connectToBook, disconnectFromBook,
    getUserPartitions, getDocumentCountForUser,
    bindGroupToUser, getGroupBinding, getPartitionById,
    getPartitionDocumentCount, getUserPartitionsWithStats,
    GroupBinding, unbindGroup, updateGroupBindingPartition,
    updateGroupBindingSettings
} from './db/services';
import { getT, LangType } from './i18n';
import { setupContextCommands } from './services/contextManager';
import { shutdownOcrWorker } from './services/ocrManager';
import {
    downloadFile,
    hasMeaningfulPdfText,
    parsePdfToText,
    PdfParseProgressEvent,
    processAndStoreDocument
} from './services/pdfManager';
import { askAiWithContext } from './services/askManager';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'PUT_YOUR_TOKEN_HERE') {
    console.error("Please set TELEGRAM_BOT_TOKEN in .env file.");
    process.exit(1);
}

export interface MyContext extends Context {
    userLang: LangType;
    isSubscribed: boolean;
}

const bot = new Telegraf<MyContext>(token);
let cachedBotUsername = '';
let cachedBotId: number | null = null;

// In-memory state for waiting for input
const waitingForInviteCode = new Set<number>();
const waitingForCustomCodeCreation = new Set<number>();

// Middleware to inject user state and language
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const userId = ctx.from.id;
        const username = ctx.from.username || 'unknown';
        await createUser(userId, username);
        const user = await getUser(userId);
        if (user) {
            ctx.userLang = user.language;
            ctx.isSubscribed = Boolean(user.isSubscribed);
        } else {
            ctx.userLang = 'zh';
            ctx.isSubscribed = false;
        }
    }
    return next();
});

// Setup Commands Menu — private chat commands
bot.telegram.setMyCommands([
    { command: 'start', description: '启动 / Start' },
    { command: 'context', description: '管理知识库 / Manage PDF' },
    { command: 'ask', description: '提问 / Ask' },
    { command: 'invite', description: '生成邀请码 / Generate invite code' },
    { command: 'connect', description: '连接他人Book / Connect to a Book' },
    { command: 'disconnect', description: '断开连接 / Disconnect' },
    { command: 'mybook', description: '我的Book状态 / My Book status' },
    { command: 'subscribe', description: '订阅 / Subscribe' },
    { command: 'settings', description: '设置 / Settings' },
    { command: 'help', description: '帮助 / Help' },
], { scope: { type: 'all_private_chats' } });

// Setup Commands Menu — group chat commands
bot.telegram.setMyCommands([
    { command: 'ask', description: '提问 / Ask a question' },
    { command: 'bind', description: '绑定知识分区 / Bind partition' },
    { command: 'unbind', description: '解除绑定 / Unbind' },
    { command: 'groupstatus', description: '群聊状态 / Group status' },
    { command: 'groupsettings', description: '群聊设置 / Group settings' },
    { command: 'help', description: '帮助 / Help' },
], { scope: { type: 'all_group_chats' } });

// =====================
// /start - Dual option
// =====================
bot.command('start', async (ctx) => {
    const t = getT(ctx.userLang);
    const text = `${t.welcome_title}\n\n${t.welcome_desc}`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(t.btn_create_book, 'action_create_book')],
        [Markup.button.callback(t.btn_connect_book, 'action_connect_book')],
    ]);
    await ctx.reply(text, keyboard);
});

bot.action('action_create_book', async (ctx) => {
    const t = getT(ctx.userLang);
    await ctx.reply(t.create_book_guide);
    await ctx.answerCbQuery();
});

bot.action('action_connect_book', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    waitingForInviteCode.add(ctx.from.id);
    await ctx.reply(t.connect_prompt);
    await ctx.answerCbQuery();
});

// =====================
// /invite
// =====================
bot.command('invite', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    const docCount = await getDocumentCountForUser(ctx.from.id);
    if (docCount === 0) {
        return ctx.reply(t.invite_no_docs);
    }

    // Check if user already has a code to show them
    const currentCode = await getInviteCode(ctx.from.id);
    if (currentCode) {
        await ctx.reply(t.invite_current.replace('{code}', currentCode), { parse_mode: 'Markdown' });
    }

    // Enter state to wait for their custom code input
    waitingForCustomCodeCreation.add(ctx.from.id);
    await ctx.reply(t.invite_prompt);
});

async function handleCustomCodeCreation(ctx: MyContext, codeInput: string) {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    const result = await setInviteCode(ctx.from.id, codeInput);

    if (result.success) {
        await ctx.reply(t.invite_set_success.replace('{code}', codeInput.trim().toUpperCase()), { parse_mode: 'Markdown' });
    } else if (result.error === 'taken') {
        waitingForCustomCodeCreation.add(ctx.from.id); // Add back to state
        await ctx.reply(t.invite_taken);
    } else {
        waitingForCustomCodeCreation.add(ctx.from.id); // Add back to state
        await ctx.reply(t.invite_too_short);
    }
}

// =====================
// /connect
// =====================
bot.command('connect', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);

    // Check if there's a code in the command args
    const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (args) {
        await handleInviteCodeInput(ctx, args);
    } else {
        waitingForInviteCode.add(ctx.from.id);
        await ctx.reply(t.connect_prompt);
    }
});

// =====================
// /disconnect
// =====================
bot.command('disconnect', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    const user = await getUser(ctx.from.id);
    if (!user || !user.connectedToUserId) {
        return ctx.reply(t.disconnect_none);
    }
    await disconnectFromBook(ctx.from.id);
    await ctx.reply(t.disconnect_success);
});

// =====================
// /mybook
// =====================
bot.command('mybook', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    const partitions = await getUserPartitions(ctx.from.id);
    const docCount = await getDocumentCountForUser(ctx.from.id);
    const code = await getInviteCode(ctx.from.id);
    await ctx.reply(
        t.mybook_info
            .replace('{partitions}', String(partitions.length))
            .replace('{docs}', String(docCount))
            .replace('{code}', code || t.mybook_no_code)
    );
});

// =====================
// /subscribe
// =====================
bot.command('subscribe', async (ctx) => {
    const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('💎 Pay $2.99 / mo', 'action_subscribe')
    ]);
    await ctx.reply("Click below to subscribe:", keyboard);
});

bot.action('action_subscribe', async (ctx) => {
    if (ctx.from) {
        await subscribeUser(ctx.from.id);
        const t = getT(ctx.userLang);
        await ctx.reply(t.subscribe_success);
        await ctx.answerCbQuery();
    }
});

// =====================
// /settings & /help & lang switch
// =====================
bot.command('settings', async (ctx) => {
    const t = getT(ctx.userLang);
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🌐 Switch to ' + (ctx.userLang === 'zh' ? 'English' : '中文'), 'action_switch_lang')]
    ]);
    await ctx.reply(t.settings_title, keyboard);
});

bot.command('help', async (ctx) => {
    const t = getT(ctx.userLang);
    await ctx.reply(t.settings_desc);
});

bot.action('action_switch_lang', async (ctx) => {
    if (ctx.from) {
        const newLang = ctx.userLang === 'zh' ? 'en' : 'zh';
        await updateUserLanguage(ctx.from.id, newLang);
        const t = getT(newLang);
        await ctx.reply(t.switching_lang);
        await ctx.answerCbQuery();
    }
});

bot.command('ask', async (ctx) => {
    const t = getT(ctx.userLang);
    const question = getCommandPayload('text' in ctx.message ? ctx.message.text : '');

    if (!question) {
        if (isGroupChat(ctx)) {
            await ctx.reply(t.group_ask_usage, { parse_mode: 'Markdown' });
            return;
        }

        await ctx.reply(t.ask_prompt);
        return;
    }

    if (isGroupChat(ctx)) {
        const binding = await getGroupBinding(getCurrentChatId(ctx) || 0);
        if (!binding) {
            await ctx.reply(t.group_not_bound);
            return;
        }

        if (binding.triggerMode !== 'mention_reply_slash') {
            await ctx.reply(`${t.group_status_methods_label}: ${getGroupAskMethodsLabel(t, binding.triggerMode)}`);
            return;
        }

        await handleGroupQuestion(ctx, question, binding);
        return;
    }

    await handlePrivateQuestion(ctx, question);
});

// =====================
// Group chat commands
// =====================
bot.command('bind', async (ctx) => {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    if (!(await ensureGroupAdmin(ctx))) {
        return;
    }

    const partitions = await getUserPartitionsWithStats(ctx.from.id);
    const availablePartitions = partitions.filter((partition) => partition.documentCount > 0);
    if (availablePartitions.length === 0) {
        await ctx.reply(t.bind_no_docs);
        return;
    }

    if (availablePartitions.length === 1 && availablePartitions[0]) {
        const partition = availablePartitions[0];
        const binding = await bindGroupToUser(
            getCurrentChatId(ctx)!,
            ctx.from.id,
            partition.id,
            {},
            ctx.from.id
        );

        if (binding) {
            await ctx.reply(
                t.bind_success_partition
                    .replace('{username}', ctx.from.username || 'User')
                    .replace('{partition}', partition.name)
                    .replace('{methods}', getGroupAskMethodsLabel(t, binding.triggerMode))
            );
            await replyWithGroupStatus(ctx, binding, true);
        }
        return;
    }

    await replyWithGroupPartitionPicker(ctx, ctx.from.id, 'bind');
});

bot.command('unbind', async (ctx) => {
    if (!(await ensureGroupAdmin(ctx))) {
        return;
    }

    await unbindGroup(getCurrentChatId(ctx)!);
    await ctx.reply(getT(ctx.userLang).group_unbind_success);
});

bot.command('groupstatus', async (ctx) => {
    const t = getT(ctx.userLang);
    if (!isGroupChat(ctx)) {
        await ctx.reply(t.group_only_command);
        return;
    }

    const binding = await getGroupBinding(getCurrentChatId(ctx)!);
    if (!binding) {
        await ctx.reply(t.group_status_not_bound);
        return;
    }

    await replyWithGroupStatus(ctx, binding);
});

bot.command('groupsettings', async (ctx) => {
    const t = getT(ctx.userLang);
    if (!(await ensureGroupAdmin(ctx))) {
        return;
    }

    const binding = await getGroupBinding(getCurrentChatId(ctx)!);
    if (!binding) {
        await ctx.reply(t.group_status_not_bound);
        return;
    }

    await replyWithGroupStatus(ctx, binding, true);
});

// =====================
// Context commands (partition management)
// =====================
setupContextCommands(bot);

// =====================
// Inline button handlers for /start sub-actions
// =====================
bot.action('cmd_context', async (ctx) => {
    const t = getT(ctx.userLang);
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(t.btn_create_partition, 'action_create_partition')],
        [Markup.button.callback(t.btn_my_partitions, 'action_my_partitions')],
        [Markup.button.callback(t.btn_partition_settings, 'action_partition_settings')],
    ]);
    await ctx.reply(t.context_menu, keyboard);
    await ctx.answerCbQuery();
});

bot.action('cmd_help', async (ctx) => {
    const t = getT(ctx.userLang);
    await ctx.reply(t.settings_desc);
    await ctx.answerCbQuery();
});

// =====================
// Helper: process invite code input
// =====================
async function handleInviteCodeInput(ctx: MyContext, code: string) {
    if (!ctx.from) return;
    const t = getT(ctx.userLang);
    const result = await resolveInviteCode(code);
    if (!result) {
        return ctx.reply(t.connect_invalid);
    }
    if (result.ownerUserId === ctx.from.id) {
        return ctx.reply(t.connect_self);
    }
    await connectToBook(ctx.from.id, result.ownerUserId);
    await ctx.reply(t.connect_success.replace('{username}', result.username || 'User'));
}

function getCommandPayload(text?: string) {
    if (!text) {
        return '';
    }

    const match = text.trim().match(/^\/[a-z_]+(?:@\w+)?\s*([\s\S]*)$/i);
    return match?.[1]?.trim() || '';
}

function getCurrentChatId(ctx: MyContext) {
    return ctx.chat?.id || (ctx.callbackQuery as any)?.message?.chat?.id || null;
}

function isGroupChat(ctx: MyContext) {
    return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

async function isGroupAdmin(ctx: MyContext, userId?: number | null) {
    const chatId = getCurrentChatId(ctx);
    if (!chatId || !userId || !isGroupChat(ctx)) {
        return false;
    }

    const admins = await ctx.telegram.getChatAdministrators(chatId);
    return admins.some((admin) => admin.user.id === userId);
}

async function ensureGroupAdmin(ctx: MyContext) {
    const t = getT(ctx.userLang);
    if (!isGroupChat(ctx)) {
        await ctx.reply(t.group_only_command);
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
        }
        return false;
    }

    if (!(await isGroupAdmin(ctx, ctx.from?.id))) {
        await ctx.reply(t.group_admin_only);
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery();
        }
        return false;
    }

    return true;
}

function getReplyStyleLabel(t: ReturnType<typeof getT>, style: GroupBinding['replyStyle']) {
    if (style === 'concise') {
        return t.reply_style_concise;
    }

    if (style === 'detailed') {
        return t.reply_style_detailed;
    }

    return t.reply_style_balanced;
}

function getKnowledgeModeLabel(t: ReturnType<typeof getT>, mode: GroupBinding['knowledgeMode']) {
    return mode === 'strict' ? t.knowledge_mode_strict : t.knowledge_mode_hybrid;
}

function getCitationModeLabel(t: ReturnType<typeof getT>, citationMode: number) {
    return citationMode ? t.citation_mode_on : t.citation_mode_off;
}

function getGroupAccessLabel(t: ReturnType<typeof getT>, accessMode: GroupBinding['accessMode']) {
    return accessMode === 'admins_only' ? t.group_access_admins_only : t.group_access_all_members;
}

function getGroupTriggerLabel(t: ReturnType<typeof getT>, triggerMode: GroupBinding['triggerMode']) {
    if (triggerMode === 'mention_only') {
        return t.group_trigger_mention_only;
    }

    if (triggerMode === 'mention_or_reply') {
        return t.group_trigger_mention_or_reply;
    }

    return t.group_trigger_mention_reply_slash;
}

function getGroupAskMethodsLabel(t: ReturnType<typeof getT>, triggerMode: GroupBinding['triggerMode']) {
    if (triggerMode === 'mention_only') {
        return t.group_status_methods_mention_only;
    }

    if (triggerMode === 'mention_or_reply') {
        return t.group_status_methods_mention_or_reply;
    }

    return t.group_status_methods_mention_reply_slash;
}

function getGroupOwnerLabel(binding: GroupBinding) {
    return binding.ownerUsername ? `@${binding.ownerUsername}` : String(binding.ownerUserId);
}

function formatGroupBindingStatus(t: ReturnType<typeof getT>, binding: GroupBinding) {
    return [
        t.group_status_title,
        '',
        `${t.group_status_owner_label}: ${getGroupOwnerLabel(binding)}`,
        `${t.group_status_partition_label}: ${binding.partitionName || binding.partitionId || 'N/A'}`,
        `${t.group_status_access_label}: ${getGroupAccessLabel(t, binding.accessMode)}`,
        `${t.group_status_trigger_label}: ${getGroupTriggerLabel(t, binding.triggerMode)}`,
        `${t.group_status_reply_label}: ${getReplyStyleLabel(t, binding.replyStyle)}`,
        `${t.group_status_knowledge_label}: ${getKnowledgeModeLabel(t, binding.knowledgeMode)}`,
        `${t.group_status_citation_label}: ${getCitationModeLabel(t, binding.citationMode)}`,
        `${t.group_status_methods_label}: ${getGroupAskMethodsLabel(t, binding.triggerMode)}`,
    ].join('\n');
}

function renderGroupSettingsKeyboard(t: ReturnType<typeof getT>) {
    return Markup.inlineKeyboard([
        [Markup.button.callback(t.group_settings_partition_button, 'action_group_show_partitions')],
        [
            Markup.button.callback(t.group_access_all_members, 'action_group_access_all_members'),
            Markup.button.callback(t.group_access_admins_only, 'action_group_access_admins_only'),
        ],
        [
            Markup.button.callback(t.group_trigger_mention_only, 'action_group_trigger_mention_only'),
        ],
        [
            Markup.button.callback(t.group_trigger_mention_or_reply, 'action_group_trigger_mention_or_reply'),
            Markup.button.callback(t.group_trigger_mention_reply_slash, 'action_group_trigger_mention_reply_slash'),
        ],
        [
            Markup.button.callback(t.reply_style_concise, 'action_group_reply_concise'),
            Markup.button.callback(t.reply_style_balanced, 'action_group_reply_balanced'),
            Markup.button.callback(t.reply_style_detailed, 'action_group_reply_detailed'),
        ],
        [
            Markup.button.callback(t.knowledge_mode_strict, 'action_group_knowledge_strict'),
            Markup.button.callback(t.knowledge_mode_hybrid, 'action_group_knowledge_hybrid'),
        ],
        [
            Markup.button.callback(t.citation_mode_on, 'action_group_citation_1'),
            Markup.button.callback(t.citation_mode_off, 'action_group_citation_0'),
        ],
        [Markup.button.callback(t.group_unbind_button, 'action_group_unbind')],
    ]);
}

async function replyWithGroupStatus(ctx: MyContext, binding: GroupBinding, withSettings = false) {
    const t = getT(ctx.userLang);
    const text = withSettings
        ? `${t.group_settings_title}\n\n${formatGroupBindingStatus(t, binding)}`
        : formatGroupBindingStatus(t, binding);

    if (withSettings) {
        await ctx.reply(text, renderGroupSettingsKeyboard(t));
        return;
    }

    await ctx.reply(text);
}

async function replyWithGroupPartitionPicker(
    ctx: MyContext,
    ownerUserId: number,
    action: 'bind' | 'switch',
    currentPartitionId?: number | null
) {
    const t = getT(ctx.userLang);
    const partitions = await getUserPartitionsWithStats(ownerUserId);
    const availablePartitions = partitions.filter((partition) => partition.documentCount > 0);

    if (availablePartitions.length === 0) {
        await ctx.reply(t.bind_no_docs);
        return;
    }

    const buttons = availablePartitions.map((partition) => {
        const prefix = partition.id === currentPartitionId ? '✅ ' : '📁 ';
        const callbackData = action === 'bind'
            ? `action_group_bind_partition_${partition.id}`
            : `action_group_switch_partition_${partition.id}`;

        return [
            Markup.button.callback(
                `${prefix}${partition.name} (${partition.documentCount})`,
                callbackData
            )
        ];
    });

    await ctx.reply(t.bind_choose_partition, Markup.inlineKeyboard(buttons));
}

function getOcrPassLabel(t: ReturnType<typeof getT>, passName?: string) {
    if (passName === 'single_block') {
        return t.ocr_pass_single_block;
    }

    if (passName === 'sparse_text') {
        return t.ocr_pass_sparse_text;
    }

    return t.ocr_pass_auto;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(error: any) {
    const candidates = [
        error?.parameters?.retry_after,
        error?.response?.parameters?.retry_after,
        error?.on?.payload?.parameters?.retry_after,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }
    }

    const message = String(error?.message || '');
    const match = message.match(/retry after\s+(\d+)/i);
    return match ? Number(match[1]) : null;
}

function isMessageNotModifiedError(error: any) {
    return String(error?.message || '').includes('message is not modified');
}

async function safeEditMessageText(
    ctx: MyContext,
    chatId: number,
    messageId: number,
    text: string,
    maxRetries = 3
) {
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            await ctx.telegram.editMessageText(chatId, messageId, undefined, text);
            return true;
        } catch (error: any) {
            if (isMessageNotModifiedError(error)) {
                return true;
            }

            const retryAfter = getRetryAfterSeconds(error);
            if (retryAfter && attempt < maxRetries) {
                await sleep((retryAfter + 1) * 1000);
                attempt += 1;
                continue;
            }

            throw error;
        }
    }

    return false;
}

async function safeEditMessageTextOrSend(
    ctx: MyContext,
    chatId: number,
    messageId: number,
    text: string
) {
    try {
        await safeEditMessageText(ctx, chatId, messageId, text);
        return true;
    } catch (error: any) {
        console.error('Failed to edit message, sending a new message instead:', error);
        await ctx.telegram.sendMessage(chatId, text);
        return false;
    }
}

function getProgressFingerprint(event: PdfParseProgressEvent) {
    if (event.stage !== 'ocr_progress') {
        return `${event.stage}:${event.pageNumber || 0}:${event.passName || ''}`;
    }

    const progress = typeof event.progress === 'number' ? event.progress : 0;
    const bucket = Math.min(100, Math.max(0, Math.floor(progress * 100 / 20) * 20));
    return `${event.stage}:${event.pageNumber || 0}:${event.passName || ''}:${bucket}`;
}

function renderPdfProgress(
    t: ReturnType<typeof getT>,
    fileName: string,
    event: PdfParseProgressEvent
) {
    const header = t.pdf_received.replace('{name}', fileName);

    if (event.stage === 'extracting_text') {
        return `${header}\n\n${t.pdf_progress_extracting}`;
    }

    if (event.stage === 'rendering_pages') {
        return `${header}\n\n${t.pdf_progress_rendering}`;
    }

    if (event.stage === 'ocr_initializing') {
        return `${header}\n\n${t.pdf_progress_ocr_loading}`;
    }

    if (event.stage === 'ocr_page_start') {
        return `${header}\n\n${t.pdf_progress_ocr_page
            .replace('{current}', String(event.pageNumber || 1))
            .replace('{total}', String(event.totalPages || 1))}`;
    }

    if (event.stage === 'ocr_progress') {
        return `${header}\n\n${t.pdf_progress_ocr_page_pass
            .replace('{current}', String(event.pageNumber || 1))
            .replace('{total}', String(event.totalPages || 1))
            .replace('{pass}', getOcrPassLabel(t, event.passName))
            .replace('{percent}', String(Math.max(1, Math.round((event.progress || 0) * 100))))}`;
    }

    if (event.stage === 'ocr_complete') {
        return `${header}\n\n${t.pdf_progress_indexing}`;
    }

    return `${header}\n\n${t.pdf_progress_indexing}`;
}

function createPdfProgressReporter(
    ctx: MyContext,
    messageId: number,
    fileName: string
) {
    const chatId = ctx.chat?.id;
    let lastRendered = '';
    let lastFingerprint = '';
    let lastSentAt = 0;

    return async (event: PdfParseProgressEvent, force = false) => {
        if (!chatId) {
            return;
        }
        const t = getT(ctx.userLang);
        const text = renderPdfProgress(t, fileName, event);
        const fingerprint = getProgressFingerprint(event);
        const now = Date.now();

        if (!force && (text === lastRendered || fingerprint === lastFingerprint)) {
            return;
        }

        if (!force && now - lastSentAt < 2500) {
            return;
        }

        try {
            await safeEditMessageText(ctx, chatId, messageId, text);
            lastRendered = text;
            lastFingerprint = fingerprint;
            lastSentAt = Date.now();
        } catch (error: any) {
            console.error('Failed to update PDF progress:', error);
        }
    };
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractGroupQuestion(message: any, triggerMode: GroupBinding['triggerMode']) {
    if (!message || !('text' in message) || typeof message.text !== 'string') {
        return null;
    }

    const text = message.text.trim();
    if (!text) {
        return null;
    }

    // Always use the most up-to-date identity
    const username = cachedBotUsername || bot.botInfo?.username || '';
    const botId = cachedBotId || bot.botInfo?.id || null;
    const allowReply = triggerMode !== 'mention_only';
    const replyToBot = Boolean(allowReply && botId && message.reply_to_message?.from?.id === botId);
    const mentionRegex = username
        ? new RegExp(`@${escapeRegex(username)}\\b`, 'ig')
        : null;

    let mentionTriggered = false;

    if (Array.isArray(message.entities)) {
        mentionTriggered = message.entities.some((entity: any) => {
            if (entity.type === 'mention') {
                const raw = text.substring(entity.offset, entity.offset + entity.length);
                // Match by username if available, otherwise any @mention that looks like a bot name
                if (username) {
                    return raw.toLowerCase() === `@${username}`.toLowerCase();
                }
                // If username not cached yet, accept any @mention as potential bot mention
                return true;
            }

            if (entity.type === 'text_mention') {
                return Boolean(botId && entity.user?.id === botId);
            }

            return false;
        });
    }

    if (!mentionTriggered && mentionRegex) {
        mentionTriggered = mentionRegex.test(text);
    }

    if (!mentionTriggered && !replyToBot) {
        return null;
    }

    const cleaned = mentionTriggered && mentionRegex
        ? text.replace(mentionRegex, '').replace(/^[\s,:，：-]+/, '').trim()
        : text;

    return cleaned || (replyToBot ? text : null);
}

async function handlePrivateQuestion(ctx: MyContext, question: string) {
    if (!ctx.from) return;

    const t = getT(ctx.userLang);
    const user = await getUser(ctx.from.id);
    const targetUserId = user?.connectedToUserId || undefined;

    // Allow users who have their own docs, have connected to someone else's book, or are subscribed
    const hasOwnDocs = (await getDocumentCountForUser(ctx.from.id)) > 0;
    const canAsk = ctx.isSubscribed || targetUserId || hasOwnDocs;
    if (!canAsk) {
        await ctx.reply(t.need_subscribe);
        return;
    }

    const waitMsg = await ctx.reply(t.thinking);
    try {
        const response = await askAiWithContext(ctx, question, {
            targetUserId,
            chatType: 'private',
        });
        await safeEditMessageTextOrSend(ctx, getCurrentChatId(ctx)!, waitMsg.message_id, response);
    } catch (err: any) {
        console.error("AI Error:", err);
        await ctx.reply("System Error: Could not connect to AI.");
    }
}

async function handleGroupQuestion(ctx: MyContext, question: string, binding?: GroupBinding | null) {
    if (!ctx.from) return;

    const t = getT(ctx.userLang);
    const chatId = getCurrentChatId(ctx);
    if (!chatId) {
        return;
    }

    const groupBinding = binding || await getGroupBinding(chatId);
    if (!groupBinding) {
        await ctx.reply(t.group_not_bound);
        return;
    }

    if (!groupBinding.partitionId || !groupBinding.partitionName) {
        await ctx.reply(t.group_partition_missing);
        return;
    }

    const partitionDocCount = await getPartitionDocumentCount(groupBinding.partitionId);
    if (partitionDocCount === 0) {
        await ctx.reply(t.bind_partition_empty);
        return;
    }

    if (groupBinding.accessMode === 'admins_only' && !(await isGroupAdmin(ctx, ctx.from.id))) {
        await ctx.reply(t.group_access_denied);
        return;
    }

    // Build @mention prefix to precisely tag the questioner
    const questionerUsername = ctx.from.username;
    const questionerId = ctx.from.id;
    const mentionPrefix = questionerUsername
        ? `@${questionerUsername} `
        : `[${ctx.from.first_name || 'User'}](tg://user?id=${questionerId}) `;

    // Send "thinking" message that tags the questioner so they know it's for them
    const thinkingText = `${mentionPrefix}🤔 Agent 正在思考中...`;
    const waitMsg = await ctx.reply(thinkingText, { parse_mode: 'Markdown' });

    console.log(`[Group] Answering question from @${questionerUsername || questionerId} in chat ${chatId}: "${question.slice(0, 80)}"`);

    try {
        const response = await askAiWithContext(ctx, question, {
            targetUserId: groupBinding.ownerUserId,
            partitionId: groupBinding.partitionId,
            chatType: 'group',
            chatId,
            settingsOverride: {
                replyStyle: groupBinding.replyStyle,
                knowledgeMode: groupBinding.knowledgeMode,
                citationMode: groupBinding.citationMode,
            },
        });

        // Prepend @mention to the final answer so it's clearly addressed to the questioner
        const finalText = questionerUsername
            ? `@${questionerUsername}\n\n${response}`
            : response;

        await safeEditMessageTextOrSend(ctx, chatId, waitMsg.message_id, finalText);
        console.log(`[Group] Replied to @${questionerUsername || questionerId} successfully.`);
    } catch (err: any) {
        console.error("AI Error (group):", err);
        const errorText = `${mentionPrefix}❌ 抱歉，AI 回复时出现错误，请稍后再试。`;
        await safeEditMessageTextOrSend(ctx, chatId, waitMsg.message_id, errorText);
    }
}

bot.on('new_chat_members', async (ctx, next) => {
    const newMembers = 'new_chat_members' in ctx.message ? ctx.message.new_chat_members : [];
    const botWasAdded = newMembers.some((member: any) => {
        if (cachedBotId && member.id === cachedBotId) {
            return true;
        }

        return Boolean(cachedBotUsername && member.username?.toLowerCase() === cachedBotUsername.toLowerCase());
    });

    if (botWasAdded) {
        await ctx.reply(getT(ctx.userLang).group_welcome);
    }

    return next();
});

bot.action(/action_group_bind_partition_(\d+)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const t = getT(ctx.userLang);
    const match = ctx.match;
    const partitionId = Number(match[1]);
    const partition = await getPartitionById(ctx.from.id, partitionId);
    if (!partition) {
        await ctx.reply(t.bind_partition_missing);
        await ctx.answerCbQuery();
        return;
    }

    if ((await getPartitionDocumentCount(partitionId)) === 0) {
        await ctx.reply(t.bind_partition_empty);
        await ctx.answerCbQuery();
        return;
    }

    const binding = await bindGroupToUser(getCurrentChatId(ctx)!, ctx.from.id, partitionId, {}, ctx.from.id);
    if (binding) {
        await ctx.reply(
            t.bind_success_partition
                .replace('{username}', ctx.from.username || 'User')
                .replace('{partition}', partition.name)
                .replace('{methods}', getGroupAskMethodsLabel(t, binding.triggerMode))
        );
        await replyWithGroupStatus(ctx, binding, true);
    }
    await ctx.answerCbQuery();
});

bot.action('action_group_show_partitions', async (ctx) => {
    if (!(await ensureGroupAdmin(ctx))) {
        return;
    }

    const binding = await getGroupBinding(getCurrentChatId(ctx)!);
    if (!binding) {
        await ctx.reply(getT(ctx.userLang).group_status_not_bound);
        await ctx.answerCbQuery();
        return;
    }

    await replyWithGroupPartitionPicker(ctx, binding.ownerUserId, 'switch', binding.partitionId);
    await ctx.answerCbQuery();
});

bot.action(/action_group_switch_partition_(\d+)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const t = getT(ctx.userLang);
    const binding = await getGroupBinding(getCurrentChatId(ctx)!);
    if (!binding) {
        await ctx.reply(t.group_status_not_bound);
        await ctx.answerCbQuery();
        return;
    }

    const match = ctx.match;
    const partitionId = Number(match[1]);
    const partition = await getPartitionById(binding.ownerUserId, partitionId);
    if (!partition) {
        await ctx.reply(t.bind_partition_missing);
        await ctx.answerCbQuery();
        return;
    }

    if ((await getPartitionDocumentCount(partitionId)) === 0) {
        await ctx.reply(t.bind_partition_empty);
        await ctx.answerCbQuery();
        return;
    }

    const updatedBinding = await updateGroupBindingPartition(getCurrentChatId(ctx)!, partitionId, ctx.from.id);
    if (updatedBinding) {
        await ctx.reply(t.group_settings_updated);
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery();
});

bot.action(/action_group_access_(all_members|admins_only)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const updatedBinding = await updateGroupBindingSettings(
        getCurrentChatId(ctx)!,
        { accessMode: ctx.match[1] as GroupBinding['accessMode'] },
        ctx.from.id
    );
    if (updatedBinding) {
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery(getT(ctx.userLang).group_settings_updated);
});

bot.action(/action_group_trigger_(mention_only|mention_or_reply|mention_reply_slash)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const updatedBinding = await updateGroupBindingSettings(
        getCurrentChatId(ctx)!,
        { triggerMode: ctx.match[1] as GroupBinding['triggerMode'] },
        ctx.from.id
    );
    if (updatedBinding) {
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery(getT(ctx.userLang).group_settings_updated);
});

bot.action(/action_group_reply_(concise|balanced|detailed)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const updatedBinding = await updateGroupBindingSettings(
        getCurrentChatId(ctx)!,
        { replyStyle: ctx.match[1] as GroupBinding['replyStyle'] },
        ctx.from.id
    );
    if (updatedBinding) {
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery(getT(ctx.userLang).group_settings_updated);
});

bot.action(/action_group_knowledge_(strict|hybrid)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const updatedBinding = await updateGroupBindingSettings(
        getCurrentChatId(ctx)!,
        { knowledgeMode: ctx.match[1] as GroupBinding['knowledgeMode'] },
        ctx.from.id
    );
    if (updatedBinding) {
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery(getT(ctx.userLang).group_settings_updated);
});

bot.action(/action_group_citation_(0|1)/, async (ctx) => {
    if (!ctx.from || !(await ensureGroupAdmin(ctx))) {
        return;
    }

    const updatedBinding = await updateGroupBindingSettings(
        getCurrentChatId(ctx)!,
        { citationMode: Number(ctx.match[1]) },
        ctx.from.id
    );
    if (updatedBinding) {
        await replyWithGroupStatus(ctx, updatedBinding, true);
    }
    await ctx.answerCbQuery(getT(ctx.userLang).group_settings_updated);
});

bot.action('action_group_unbind', async (ctx) => {
    if (!(await ensureGroupAdmin(ctx))) {
        return;
    }

    await unbindGroup(getCurrentChatId(ctx)!);
    await ctx.reply(getT(ctx.userLang).group_unbind_success);
    await ctx.answerCbQuery();
});

// =====================
// Main message handler
// =====================
bot.on('message', async (ctx, next) => {
    const t = getT(ctx.userLang);
    const chatType = ctx.chat?.type || 'private';

    // ---- GROUP CHAT: handle @mention ----
    if (chatType === 'group' || chatType === 'supergroup') {
        const groupChatId = ctx.chat?.id;
        if (!groupChatId) {
            return next();
        }

        const msgText = 'text' in ctx.message ? ctx.message.text : '[non-text]';
        console.log(`[Group] Message received in chat ${groupChatId} from @${ctx.from?.username || ctx.from?.id || 'unknown'
            }: "${msgText.slice(0, 100)}"`);

        const binding = await getGroupBinding(groupChatId);
        const question = binding
            ? extractGroupQuestion(ctx.message, binding.triggerMode)
            : extractGroupQuestion(ctx.message, 'mention_reply_slash');

        console.log(`[Group] Extracted question: ${question ? `"${question.slice(0, 80)}"` : 'null (not triggered)'}`);

        if (question) {
            if (!binding) {
                return ctx.reply(t.group_not_bound);
            }
            await handleGroupQuestion(ctx, question, binding);
        }
        return next();
    }

    // ---- PRIVATE CHAT ----

    // Handle document uploads (PDF)
    if ('document' in ctx.message) {
        const doc = ctx.message.document;
        if (doc.mime_type === 'application/pdf') {
            if (!ctx.from) return;
            const user = await getUser(ctx.from.id);
            if (!user || !user.activePartitionId) {
                await ctx.reply("Please set an active partition first using /context -> 📁 My Partitions, before uploading a PDF.");
                return;
            }
            const msg = await ctx.reply(t.pdf_received.replace('{name}', doc.file_name || 'unknown'));
            try {
                const reportProgress = createPdfProgressReporter(ctx, msg.message_id, doc.file_name || 'unknown');
                const fileUrlRequest = await ctx.telegram.getFileLink(doc.file_id);
                const buffer = await downloadFile(fileUrlRequest.href);
                const text = await parsePdfToText(buffer, {
                    onProgress: async (event) => {
                        await reportProgress(event);
                    },
                });
                if (!hasMeaningfulPdfText(text)) {
                    throw new Error(t.pdf_no_text);
                }
                await reportProgress({ stage: 'ocr_complete' }, true);
                await processAndStoreDocument(user.activePartitionId, text, {
                    fileId: doc.file_id,
                    fileName: doc.file_name || 'unknown'
                });
                await addDocument(doc.file_id, doc.file_name || 'unknown', user.activePartitionId);
                await safeEditMessageTextOrSend(
                    ctx,
                    ctx.chat.id,
                    msg.message_id,
                    t.pdf_processed
                        .replace('{name}', doc.file_name || 'unknown')
                        .replace('{partition}', user.activePartitionId.toString())
                );
            } catch (err: any) {
                console.error("Error processing PDF:", err);
                await ctx.reply("Error processing PDF: " + err.message);
            }
            return;
        }
    }

    // Handle text messages
    if ('text' in ctx.message && !ctx.message.text.startsWith('/')) {
        if (!ctx.from) return;

        // Check if user is waiting to input custom code to create
        if (waitingForCustomCodeCreation.has(ctx.from.id)) {
            waitingForCustomCodeCreation.delete(ctx.from.id);
            await handleCustomCodeCreation(ctx, ctx.message.text.trim());
            return;
        }

        // Check if user is waiting for invite code input to connect
        if (waitingForInviteCode.has(ctx.from.id)) {
            waitingForInviteCode.delete(ctx.from.id);
            await handleInviteCodeInput(ctx, ctx.message.text.trim());
            return;
        }

        await handlePrivateQuestion(ctx, ctx.message.text);
    }

    return next();
});

// =====================
// Start
// =====================
async function start() {
    await initDb();
    // Fetch bot identity BEFORE launching so @mention detection works immediately
    try {
        const me = await bot.telegram.getMe();
        cachedBotUsername = me.username || '';
        cachedBotId = me.id || null;
        console.log(`[Bot] Identity cached: @${cachedBotUsername} (id=${cachedBotId})`);

        // Check Group Privacy Mode
        if (!(me as any).can_read_all_group_messages) {
            console.warn('');
            console.warn('⚠️  =====================================================');
            console.warn('⚠️  WARNING: Group Privacy Mode is ENABLED!');
            console.warn('⚠️  The bot CANNOT read @mention messages in groups.');
            console.warn('⚠️  To fix: Open @BotFather → /mybots → select this bot');
            console.warn('⚠️  → Bot Settings → Group Privacy → Turn OFF');
            console.warn('⚠️  Then remove and re-add the bot to the group.');
            console.warn('⚠️  =====================================================');
            console.warn('');
        } else {
            console.log('[Bot] Group Privacy Mode is OFF — bot can read all group messages ✅');
        }
    } catch (error) {
        console.error('Failed to pre-fetch bot identity:', error);
    }
    bot.launch();
    // Re-sync after launch in case botInfo was populated by Telegraf internally
    if (!cachedBotUsername && bot.botInfo?.username) {
        cachedBotUsername = bot.botInfo.username;
        cachedBotId = bot.botInfo.id || cachedBotId;
    }
    console.log("Bot started!");
}

start();

process.once('SIGINT', async () => {
    await shutdownOcrWorker().catch((error) => {
        console.error('Failed to shut down OCR worker:', error);
    });
    bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
    await shutdownOcrWorker().catch((error) => {
        console.error('Failed to shut down OCR worker:', error);
    });
    bot.stop('SIGTERM');
});
