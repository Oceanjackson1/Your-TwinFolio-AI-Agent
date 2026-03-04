import { Telegraf, Markup } from 'telegraf';
import { MyContext } from '../bot';
import { getT } from '../i18n';
import {
    createPartition,
    getPartitionById,
    getPartitionSettings,
    getUserPartitions,
    setActivePartition,
    updatePartitionSettings,
} from '../db/services';

type UserState =
    | { state: 'WAITING_FOR_PARTITION_NAME' }
    | { state: 'WAITING_FOR_PARTITION_PERSONA'; partitionId: number };

const userStates = new Map<number, UserState>();

function buildContextKeyboard(t: any) {
    return Markup.inlineKeyboard([
        [Markup.button.callback(t.btn_create_partition, 'action_create_partition')],
        [Markup.button.callback(t.btn_my_partitions, 'action_my_partitions')],
        [Markup.button.callback(t.btn_partition_settings, 'action_partition_settings')],
    ]);
}

function formatPartitionSettingsLabel(t: any, settings: any) {
    const persona = settings.personaPrompt?.trim()
        ? settings.personaPrompt.trim().slice(0, 80)
        : t.label_not_set;
    const questionMode = settings.questionMode === 'clarify-first'
        ? t.question_mode_clarify_first
        : settings.questionMode === 'answer-first'
            ? t.question_mode_answer_first
            : t.question_mode_auto;
    const replyStyle = settings.replyStyle === 'concise'
        ? t.reply_style_concise
        : settings.replyStyle === 'detailed'
            ? t.reply_style_detailed
            : t.reply_style_balanced;
    const knowledgeMode = settings.knowledgeMode === 'strict'
        ? t.knowledge_mode_strict
        : t.knowledge_mode_hybrid;
    const citationMode = settings.citationMode ? t.citation_mode_on : t.citation_mode_off;

    return t.partition_settings_summary
        .replace('{persona}', persona)
        .replace('{questionMode}', questionMode)
        .replace('{replyStyle}', replyStyle)
        .replace('{knowledgeMode}', knowledgeMode)
        .replace('{citationMode}', citationMode);
}

async function replyWithPartitionSettings(ctx: MyContext, partitionId: number) {
    if (!ctx.from) return;

    const t = getT(ctx.userLang);
    const partition = await getPartitionById(ctx.from.id, partitionId);
    if (!partition) {
        return;
    }

    const settings = await getPartitionSettings(partitionId);
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✍️ Persona', `action_partition_persona_${partitionId}`)],
        [
            Markup.button.callback(t.question_mode_auto, `action_partition_question_${partitionId}_auto`),
            Markup.button.callback(t.question_mode_clarify_first, `action_partition_question_${partitionId}_clarify-first`),
            Markup.button.callback(t.question_mode_answer_first, `action_partition_question_${partitionId}_answer-first`),
        ],
        [
            Markup.button.callback(t.reply_style_concise, `action_partition_reply_${partitionId}_concise`),
            Markup.button.callback(t.reply_style_balanced, `action_partition_reply_${partitionId}_balanced`),
            Markup.button.callback(t.reply_style_detailed, `action_partition_reply_${partitionId}_detailed`),
        ],
        [
            Markup.button.callback(t.knowledge_mode_strict, `action_partition_knowledge_${partitionId}_strict`),
            Markup.button.callback(t.knowledge_mode_hybrid, `action_partition_knowledge_${partitionId}_hybrid`),
        ],
        [
            Markup.button.callback(t.citation_mode_on, `action_partition_citation_${partitionId}_1`),
            Markup.button.callback(t.citation_mode_off, `action_partition_citation_${partitionId}_0`),
        ],
    ]);

    await ctx.reply(
        `${t.partition_settings_title.replace('{name}', partition.name)}\n\n${formatPartitionSettingsLabel(t, settings)}`,
        keyboard
    );
}

export function setupContextCommands(bot: Telegraf<MyContext>) {

    bot.command('context', async (ctx) => {
        const t = getT(ctx.userLang);
        await ctx.reply(t.context_menu, buildContextKeyboard(t));
    });

    bot.action('action_create_partition', async (ctx) => {
        if (!ctx.from) return;
        const t = getT(ctx.userLang);
        userStates.set(ctx.from.id, { state: 'WAITING_FOR_PARTITION_NAME' });
        await ctx.reply(t.enter_partition_name);
        await ctx.answerCbQuery();
    });

    bot.action('action_my_partitions', async (ctx) => {
        if (!ctx.from) return;
        const t = getT(ctx.userLang);
        const partitions = await getUserPartitions(ctx.from.id);

        if (partitions.length === 0) {
            await ctx.reply("You don't have any partitions yet.");
        } else {
            const buttons = partitions.map((p: any) => [
                Markup.button.callback(`📁 ${p.name}`, `action_set_partition_${p.id}`)
            ]);
            await ctx.reply("Your Partitions (click to active):", Markup.inlineKeyboard(buttons));
        }
        await ctx.answerCbQuery();
    });

    bot.action('action_partition_settings', async (ctx) => {
        if (!ctx.from) return;
        const t = getT(ctx.userLang);
        const partitions = await getUserPartitions(ctx.from.id);

        if (partitions.length === 0) {
            await ctx.reply("You don't have any partitions yet.");
        } else {
            const buttons = partitions.map((partition: any) => [
                Markup.button.callback(`⚙️ ${partition.name}`, `action_config_partition_${partition.id}`)
            ]);
            await ctx.reply(t.partition_settings_choose, Markup.inlineKeyboard(buttons));
        }

        await ctx.answerCbQuery();
    });

    // Handle setting active partition
    bot.action(/action_set_partition_(\d+)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match && ctx.match[1] ? ctx.match[1] : '';
        const partitionId = parseInt(match, 10);
        const partitions = await getUserPartitions(ctx.from.id);
        const partition = partitions.find((p: any) => p.id === partitionId);

        if (partition) {
            await setActivePartition(ctx.from.id, partitionId);
            const t = getT(ctx.userLang);
            await ctx.reply(t.send_pdf_prompt.replace('{name}', partition.name));
        }
        await ctx.answerCbQuery();
    });

    bot.action(/action_config_partition_(\d+)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match && ctx.match[1] ? ctx.match[1] : '';
        const partitionId = parseInt(match, 10);
        await replyWithPartitionSettings(ctx, partitionId);
        await ctx.answerCbQuery();
    });

    bot.action(/action_partition_persona_(\d+)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match && ctx.match[1] ? ctx.match[1] : '';
        const partitionId = parseInt(match, 10);
        const t = getT(ctx.userLang);
        userStates.set(ctx.from.id, { state: 'WAITING_FOR_PARTITION_PERSONA', partitionId });
        await ctx.reply(t.partition_persona_prompt);
        await ctx.answerCbQuery();
    });

    bot.action(/action_partition_question_(\d+)_(auto|clarify-first|answer-first)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match as RegExpExecArray | null;
        if (!match) return;
        const partitionId = parseInt(match[1] || '', 10);
        const questionMode = (match[2] || 'auto') as 'auto' | 'clarify-first' | 'answer-first';
        await updatePartitionSettings(partitionId, { questionMode });
        await replyWithPartitionSettings(ctx, partitionId);
        await ctx.answerCbQuery();
    });

    bot.action(/action_partition_reply_(\d+)_(concise|balanced|detailed)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match as RegExpExecArray | null;
        if (!match) return;
        const partitionId = parseInt(match[1] || '', 10);
        const replyStyle = (match[2] || 'balanced') as 'concise' | 'balanced' | 'detailed';
        await updatePartitionSettings(partitionId, { replyStyle });
        await replyWithPartitionSettings(ctx, partitionId);
        await ctx.answerCbQuery();
    });

    bot.action(/action_partition_knowledge_(\d+)_(strict|hybrid)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match as RegExpExecArray | null;
        if (!match) return;
        const partitionId = parseInt(match[1] || '', 10);
        const knowledgeMode = (match[2] || 'hybrid') as 'strict' | 'hybrid';
        await updatePartitionSettings(partitionId, { knowledgeMode });
        await replyWithPartitionSettings(ctx, partitionId);
        await ctx.answerCbQuery();
    });

    bot.action(/action_partition_citation_(\d+)_(0|1)/, async (ctx) => {
        if (!ctx.from) return;
        const match = ctx.match as RegExpExecArray | null;
        if (!match) return;
        const partitionId = parseInt(match[1] || '', 10);
        const citationMode = parseInt(match[2] || '1', 10);
        await updatePartitionSettings(partitionId, { citationMode });
        await replyWithPartitionSettings(ctx, partitionId);
        await ctx.answerCbQuery();
    });

    bot.command('settings', async (ctx) => {
        const t = getT(ctx.userLang);
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🌐 Switch to ' + (ctx.userLang === 'zh' ? 'English' : 'Chinese'), 'action_switch_lang')]
        ]);
        await ctx.reply(t.settings_title + "\n\n" + t.settings_desc, keyboard);
    });

    // Capture text messages to handle partition names
    bot.on('text', async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();

        const state = userStates.get(userId);
        if (state && state.state === 'WAITING_FOR_PARTITION_NAME') {
            const partitionName = ctx.message.text.trim();
            const newId = await createPartition(userId, partitionName);
            if (newId) {
                await setActivePartition(userId, newId);
            }
            userStates.delete(userId);

            const t = getT(ctx.userLang);
            await ctx.reply(t.partition_created.replace('{name}', partitionName));
            return; // Stop middleware chain
        }

        if (state && state.state === 'WAITING_FOR_PARTITION_PERSONA') {
            const personaPrompt = ctx.message.text.trim();
            await updatePartitionSettings(state.partitionId, { personaPrompt });
            userStates.delete(userId);

            const t = getT(ctx.userLang);
            await ctx.reply(t.partition_persona_saved);
            await replyWithPartitionSettings(ctx, state.partitionId);
            return;
        }

        return next();
    });
}
