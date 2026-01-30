import { Context, Session, Time } from 'koishi'
import { Config } from '..'
import { ActivityScore, GroupInfo, PresetTemplate } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

// 活跃度算法常量配置
const WINDOW_SIZE = 90 // 时间戳窗口最大容量
const RECENT_WINDOW = Time.second * 90 // 频率统计窗口：1.5分钟
const SHORT_BURST_WINDOW = Time.second * 30 // 爆发检测窗口：30秒
const INSTANT_WINDOW = Time.second * 20 // 短周期窗口，用于检测瞬时活跃
const MIN_COOLDOWN_TIME = Time.second * 6 // 最小冷却时间：6秒
const COOLDOWN_PENALTY = 0.8 // 响应后降低活跃度的惩罚值
const THRESHOLD_RESET_TIME = Time.minute * 10 // 十分钟无人回复时，重置活跃度阈值

const MIN_RECENT_MESSAGES = 6 // 进入活跃度统计的最小消息数
const SUSTAINED_RATE_THRESHOLD = 10 // 持续活跃阈值（条/分钟）
const SUSTAINED_RATE_SCALE = 3 // 持续活跃斜率，越大越平缓
const INSTANT_RATE_THRESHOLD = 9 // 瞬时活跃阈值（条/分钟）
const INSTANT_RATE_SCALE = 2 // 瞬时活跃斜率
const BURST_RATE_THRESHOLD = 12 // 突发活跃阈值（条/分钟）
const BURST_RATE_SCALE = 4 // 突发活跃斜率
const SMOOTHING_WINDOW = Time.second * 8 // 分数平滑窗口
const FRESHNESS_HALF_LIFE = Time.second * 60 // 新鲜度半衰期：60秒

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const logger = service.logger

    const globalPreset = await preset.getPreset(config.defaultPreset)
    const presetPool: Record<string, PresetTemplate> = {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.on('guild-member' as any, (session: Session) => {
        if (
            !config.applyGroup.includes(session.guildId) ||
            session.event?.subtype !== 'ban' ||
            session.bot.selfId !== session.event?.user?.id
        ) {
            return
        }

        const duration = (session.event._data?.['duration'] ?? 0) * 1000

        if (duration === 0) {
            logger.warn(
                `检测到 ${session.bot.user?.name || session.selfId} 被 ${session.operatorId} 操作解禁。`
            )
            ctx.chatluna_character.mute(session, 0)
            return
        }

        logger.warn(
            `检测到 ${session.bot.user?.name || session.selfId} 被 ${session.operatorId} 操作禁言 ${duration / 1000} 秒。`
        )

        ctx.chatluna_character.mute(session, duration)
    })

    service.addFilter((session, message) => {
        const guildId = session.guildId
        // 使用完整的 botId 格式 (platform:selfId) 以匹配 charon 注册的配置
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const botGuildKey = `${botId}_${guildId}`
        const presetKey = `${guildId}:${botId}`
        const now = Date.now()

        const senderName =
            message.name ??
            session.author?.nick ??
            session.author?.name ??
            session.username ??
            'Unknown'
        const messageContent = message.content ?? ''

        logger.info(
            `[Filter] Bot: ${botId} | Guild: ${guildId} | Sender: ${senderName} | Msg: ${messageContent.length > 50 ? messageContent.slice(0, 50) + '...' : messageContent}`
        )

        // 优先使用 charon 注册的 bot 配置
        const botConfig = service.botConfig.getBotConfig(botId)
        const currentGuildConfig = config.configs[guildId]
        const copyOfConfig = Object.assign({}, config)
        let currentPreset = globalPreset

        // 确定使用的预设名称（优先级：bot配置 > guild配置 > 全局配置）
        let presetName = config.defaultPreset
        if (botConfig?.preset) {
            presetName = botConfig.preset
        } else if (currentGuildConfig?.preset) {
            presetName = currentGuildConfig.preset
        }

        // 加载预设
        if (presetPool[presetKey]) {
            currentPreset = presetPool[presetKey]
        } else {
            const template = preset.getPresetForCache(presetName)
            presetPool[presetKey] = template
            currentPreset = template
            if (config.verboseLogging) {
                const configSource = botConfig?.preset
                    ? 'charon'
                    : currentGuildConfig?.preset
                      ? 'guild'
                      : 'global'
                logger.info(
                    `[Filter] 预设: ${presetName} (来源: ${configSource})`
                )
            }
        }

        const info = groupInfos[botGuildKey] ?? {
            messageCount: 0,
            messageTimestamps: [],
            lastActivityScore: 0,
            lastScoreUpdate: 0,
            lastResponseTime: 0,
            currentActivityThreshold:
                copyOfConfig.messageActivityScoreLowerLimit,
            lastUserMessageTime: now
        }

        info.messageTimestamps.push(now)
        if (info.messageTimestamps.length > WINDOW_SIZE) {
            info.messageTimestamps.shift()
        }

        if (now - info.lastUserMessageTime >= THRESHOLD_RESET_TIME) {
            info.currentActivityThreshold =
                copyOfConfig.messageActivityScoreLowerLimit
        }

        info.lastUserMessageTime = now
        const activity = calculateActivityScore(
            info.messageTimestamps,
            info.lastResponseTime,
            copyOfConfig.maxMessages,
            info.lastActivityScore,
            info.lastScoreUpdate
        )
        info.lastActivityScore = activity.score
        info.lastScoreUpdate = activity.timestamp

        logger.debug(
            `messageCount: ${info.messageCount}, activityScore: ${activity.score.toFixed(3)}. content: ${JSON.stringify(
                Object.assign({}, message, { images: undefined })
            )}`
        )

        if (
            copyOfConfig.disableChatLuna &&
            copyOfConfig.whiteListDisableChatLuna.includes(guildId)
        ) {
            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'
            const guildMessages = ctx.chatluna_character.getMessages(
                guildId,
                botId
            )

            let maxRecentMessage = 0

            if (guildMessages == null || guildMessages.length === 0) {
                maxRecentMessage = 6
            }

            while (maxRecentMessage < 5) {
                const currentMessage =
                    guildMessages[guildMessages?.length - 1 - maxRecentMessage]

                if (currentMessage == null) {
                    return false
                }

                if (currentMessage.id === selfId) {
                    break
                }

                maxRecentMessage++
            }
        }

        let appel = session.stripped.appel

        if (!appel) {
            // 从消息元素中检测是否有被艾特当前用户
            appel = session.elements.some(
                (element) =>
                    element.type === 'at' && element.attrs?.['id'] === botId
            )
        }

        if (!appel) {
            appel = session.quote?.user?.id === botId
        }

        const isAppel = Boolean(appel)

        const muteKeywords = currentPreset.mute_keyword ?? []
        const forceMuteActive =
            copyOfConfig.isForceMute && isAppel && muteKeywords.length > 0
        const needPlainText =
            copyOfConfig.isNickname ||
            copyOfConfig.isNickNameWithContent ||
            forceMuteActive

        const plainTextContent = needPlainText
            ? (session.elements ?? [])
                  .filter((element) => element.type === 'text')
                  .map((element) => element.attrs?.content ?? '')
                  .join('')
            : ''

        if (forceMuteActive) {
            const needMute = muteKeywords.some((value) =>
                plainTextContent.includes(value)
            )

            if (needMute) {
                logger.info(
                    `[Filter] 触发静默关键词，禁言 ${config.muteTime}ms`
                )
                service.mute(session, config.muteTime)
            }
        }

        const isMute = service.isMute(session)

        // 昵称匹配检测
        const isNickname =
            copyOfConfig.isNickname &&
            currentPreset.nick_name.some((value) =>
                plainTextContent.startsWith(value)
            )
        const isNicknameWithContent =
            copyOfConfig.isNickNameWithContent &&
            currentPreset.nick_name.some((value) =>
                plainTextContent.includes(value)
            )

        const isDirectTrigger = isAppel || isNickname || isNicknameWithContent
        const messageIntervalCheck =
            info.messageCount > copyOfConfig.messageInterval
        const activityScoreCheck =
            info.lastActivityScore >= info.currentActivityThreshold

        const shouldRespond =
            messageIntervalCheck || isDirectTrigger || activityScoreCheck

        // 合并触发判断日志
        logger.info(
            `[Filter] 触发判断: isMute=${isMute}, @=${isAppel}, nickname=${isNickname || isNicknameWithContent}, ` +
                `msgCount=${info.messageCount}/${copyOfConfig.messageInterval}, ` +
                `activity=${info.lastActivityScore.toFixed(3)}/${info.currentActivityThreshold.toFixed(3)} => ` +
                `WILL_${shouldRespond && !isMute ? 'RESPOND' : 'SKIP'}`
        )

        if (shouldRespond && !isMute) {
            info.messageCount = 0
            info.lastActivityScore = Math.max(
                0,
                info.lastActivityScore - COOLDOWN_PENALTY
            )
            info.lastResponseTime = now

            const lowerLimit = copyOfConfig.messageActivityScoreLowerLimit
            const upperLimit = copyOfConfig.messageActivityScoreUpperLimit
            const step = (upperLimit - lowerLimit) * 0.1
            info.currentActivityThreshold = Math.max(
                Math.min(
                    info.currentActivityThreshold + step,
                    Math.max(lowerLimit, upperLimit)
                ),
                Math.min(lowerLimit, upperLimit)
            )

            groupInfos[botGuildKey] = info
            return true
        }

        info.messageCount++
        groupInfos[botGuildKey] = info
        return false
    })
}

function logistic(value: number): number {
    if (!Number.isFinite(value)) {
        return 0
    }

    if (value > 10) return 0.99995
    if (value < -10) return 0.00005

    return 1 / (1 + Math.exp(-value))
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/**
 * 计算消息新鲜度因子（指数衰减模型）
 */
function calculateFreshnessFactor(timestamps: number[]): number {
    if (timestamps.length === 0) return 0

    const now = Date.now()
    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    return Math.exp(-timeSinceLastMessage / FRESHNESS_HALF_LIFE)
}

function smoothScore(
    targetScore: number,
    previousScore: number,
    previousTimestamp: number,
    now: number
): number {
    if (!previousTimestamp || previousTimestamp <= 0) {
        return targetScore
    }

    const elapsed = now - previousTimestamp
    if (elapsed <= 0) {
        return targetScore
    }

    const smoothingFactor = 1 - Math.exp(-elapsed / SMOOTHING_WINDOW)
    return (
        previousScore +
        (targetScore - previousScore) * clamp(smoothingFactor, 0, 1)
    )
}

/**
 * 单次遍历统计结果
 */
interface WindowCounts {
    recentCount: number
    instantCount: number
    burstCount: number
    instantIndices: number[] // 记录 instant 消息在 timestamps 中的索引，用于后续间隔计算
}

/**
 * 单次遍历统计各窗口内的消息数量和索引
 */
function countWindows(timestamps: number[], now: number): WindowCounts {
    let recentCount = 0
    let instantCount = 0
    let burstCount = 0
    const instantIndices: number[] = []

    for (let i = 0; i < timestamps.length; i++) {
        const age = now - timestamps[i]

        if (age <= RECENT_WINDOW) {
            recentCount++
        }
        if (age <= INSTANT_WINDOW) {
            instantCount++
            instantIndices.push(i)
        }
        if (age <= SHORT_BURST_WINDOW) {
            burstCount++
        }
    }

    return { recentCount, instantCount, burstCount, instantIndices }
}

/**
 * 计算群聊活跃度综合分数
 *
 * 核心思路：
 * 1. 同时观察长/短窗口的消息速率
 * 2. 对突发消息进行额外权重处理
 * 3. 使用平滑函数降低尖峰，减少误触发
 * 4. 引入新鲜度与冷却机制
 * 5. 单次遍历统计所有窗口（优化性能）
 */
function calculateActivityScore(
    timestamps: number[],
    lastResponseTime: number | undefined,
    maxMessages: number | undefined,
    previousScore: number,
    previousTimestamp: number
): ActivityScore {
    const now = Date.now()

    if (timestamps.length < 2) {
        const score = smoothScore(0, previousScore, previousTimestamp, now)
        return { score, timestamp: now }
    }

    // 单次遍历统计所有窗口
    const counts = countWindows(timestamps, now)

    if (counts.recentCount < MIN_RECENT_MESSAGES) {
        const score = smoothScore(0, previousScore, previousTimestamp, now)
        return { score, timestamp: now }
    }

    const sustainedRate = (counts.recentCount / RECENT_WINDOW) * Time.minute
    const instantRate = (counts.instantCount / INSTANT_WINDOW) * Time.minute
    const burstRate = (counts.burstCount / SHORT_BURST_WINDOW) * Time.minute

    const sustainedComponent = logistic(
        (sustainedRate - SUSTAINED_RATE_THRESHOLD) / SUSTAINED_RATE_SCALE
    )

    const instantComponent = logistic(
        (instantRate - INSTANT_RATE_THRESHOLD) / INSTANT_RATE_SCALE
    )

    let combinedScore = sustainedComponent * 0.65 + instantComponent * 0.35

    if (burstRate > BURST_RATE_THRESHOLD) {
        const burstContribution = clamp(
            (burstRate - BURST_RATE_THRESHOLD) / BURST_RATE_SCALE,
            0,
            1
        )
        combinedScore += burstContribution * 0.25
    }

    // 使用记录的索引计算消息间隔
    if (counts.instantIndices.length >= 6) {
        const intervals: number[] = []
        for (let i = 1; i < counts.instantIndices.length; i++) {
            const prevIndex = counts.instantIndices[i - 1]
            const currIndex = counts.instantIndices[i]
            intervals.push(timestamps[currIndex] - timestamps[prevIndex])
        }

        if (intervals.length > 0) {
            const averageGap =
                intervals.reduce((total, value) => total + value, 0) /
                intervals.length
            const intervalComponent = logistic(
                (Time.second * 12 - averageGap) / (Time.second * 6)
            )
            combinedScore *= 0.7 + 0.3 * intervalComponent
        }
    }

    const freshnessFactor = calculateFreshnessFactor(timestamps)
    combinedScore *= 0.55 + 0.45 * freshnessFactor

    if (maxMessages && counts.recentCount >= maxMessages * 0.9) {
        combinedScore += 0.08
    }

    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            const cooldownRatio = timeSinceLastResponse / MIN_COOLDOWN_TIME
            combinedScore *= cooldownRatio * cooldownRatio
        }
    }

    const smoothedScore = smoothScore(
        clamp(combinedScore, 0, 1),
        previousScore,
        previousTimestamp,
        now
    )

    return { score: clamp(smoothedScore, 0, 1), timestamp: now }
}
