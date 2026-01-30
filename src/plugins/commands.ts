import { Context, Session } from 'koishi'
import { Config } from '..'
import { groupInfos } from './filter'

/**
 * 解析命令参数，支持与 charon 插件深度融合的格式
 *
 * 参数格式说明：
 * 1. "all" 或 不指定（未艾特 bot）    -> 清除该群组下所有 bot 的记录
 * 2. "groupId:botId"（charon 传入）  -> 清除指定 bot 的记录
 * 3. "botId_groupId"（内部格式）    -> 清除指定 bot 的记录
 * 4. "groupId"（兼容旧格式）         -> 清除该群组下所有 bot 的记录
 */
function parseClearTarget(
    param: string | undefined,
    session: Session
): { type: 'all' | 'single'; groupId?: string; botId?: string; key?: string } {
    // 未指定参数，默认为当前群组所有 bot
    if (!param) {
        return { type: 'all', groupId: session.guildId }
    }

    // charon 传入的特殊标记：清除所有
    if (param === 'all') {
        return { type: 'all', groupId: session.guildId }
    }

    // 格式1: "groupId:botId" (charon 标准格式)
    if (param.includes(':')) {
        const [groupId, botId] = param.split(':')
        return {
            type: 'single',
            groupId,
            botId,
            key: `${botId}_${groupId}`
        }
    }

    // 格式2: "botId_groupId" (内部键格式)
    if (param.includes('_')) {
        const parts = param.split('_')
        if (parts.length >= 2) {
            const botId = parts.slice(0, -1).join('_') // 处理 botId 可能包含 _ 的情况
            const groupId = parts[parts.length - 1]
            return {
                type: 'single',
                groupId,
                botId,
                key: param
            }
        }
    }

    // 兼容旧格式：纯 groupId，清除所有 bot
    return { type: 'all', groupId: param }
}

export function apply(ctx: Context, config: Config) {
    ctx.command('chatluna.character', '角色扮演相关命令')

    ctx.command('chatluna.character.clear [target]', '清除群组的聊天记录', {
        authority: 3
    }).action(async ({ session }, target) => {
        const parsed = parseClearTarget(target, session)

        if (parsed.type === 'all') {
            // 清除该群组下所有 bot 的记录
            const { groupId } = parsed

            if (!groupId) {
                await sendMessageToPrivate(
                    session,
                    '无法确定群组 ID，请检查是否在群聊中使用或手动指定群组 ID'
                )
                return
            }

            let clearedCount = 0
            for (const key of Object.keys(groupInfos)) {
                if (key.endsWith(`_${groupId}`)) {
                    delete groupInfos[key]
                    clearedCount++
                }
            }

            if (clearedCount === 0) {
                await sendMessageToPrivate(
                    session,
                    `未找到群组 ${groupId} 的聊天记录`
                )
                return
            }

            await ctx.chatluna_character.clear(groupId)
            await sendMessageToPrivate(
                session,
                `已清除群组 ${groupId} 的聊天记录（${clearedCount} 个 bot）`
            )
            return
        }

        // 清除指定 bot 的记录
        const { groupId, botId, key } = parsed
        if (!key || !groupInfos[key]) {
            await sendMessageToPrivate(
                session,
                `未找到 bot ${botId} 在群组 ${groupId} 的聊天记录`
            )
            return
        }

        delete groupInfos[key]
        await ctx.chatluna_character.clear(groupId)
        await sendMessageToPrivate(
            session,
            `已清除 bot ${botId} 在群组 ${groupId} 的聊天记录`
        )
    })
}

async function sendMessageToPrivate(session: Session, message: string) {
    await session.bot.sendPrivateMessage(session.userId, message)
}
