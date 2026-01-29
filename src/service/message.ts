// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Config } from '..'
import { Preset } from '../preset'
import {
    BotConfig,
    GroupLock,
    GroupTemp,
    Message,
    MessageCollectorFilter,
    MessageImage
} from '../types'

import {
    hashString,
    isMessageContentImageUrl
} from 'koishi-plugin-chatluna/utils/string'

/**
 * Bot 配置服务，允许外部插件注册和管理每个 bot 的配置
 */
class BotConfigService {
    private _botConfigs: Record<string, BotConfig> = {}

    setBotConfig(botId: string, config: BotConfig) {
        this._botConfigs[botId] = config
    }

    getBotConfig(botId: string): BotConfig | undefined {
        return this._botConfigs[botId]
    }

    hasBotConfig(botId: string): boolean {
        return botId in this._botConfigs
    }

    clearBotConfig(botId: string) {
        delete this._botConfigs[botId]
    }

    getAllConfigs(): Record<string, BotConfig> {
        return { ...this._botConfigs }
    }
}

export class MessageCollector extends Service {
    // 多 bot 支持：消息按 guildId:botId 存储
    private _messages: Record<string, Record<string, Message[]>> = {}

    private _filters: MessageCollectorFilter[] = []

    // 多 bot 支持：锁也按 botId 隔离
    private _groupLocks: Record<string, Record<string, GroupLock>> = {}

    // 多 bot 支持：临时状态也按 botId 隔离
    private _groupTemp: Record<string, Record<string, GroupTemp>> = {}

    private _responseWaiters: Record<
        string,
        {
            resolve: () => void
            reject: (reason?: string) => void
        }[]
    > = {}

    preset: Preset

    // Bot 配置服务，允许外部插件注册每个 bot 的预设和模型
    botConfig: BotConfigService

    declare logger: Logger

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character')
        this.logger = createLogger(ctx, 'chatluna-character')
        this.preset = new Preset(ctx)
        this.botConfig = new BotConfigService()
    }

    addFilter(filter: MessageCollectorFilter) {
        this._filters.push(filter)
    }

    mute(session: Session, time: number) {
        const lock = this._getGroupLocks(session.guildId)
        let mute = lock.mute ?? 0

        if (time === 0) {
            mute = 0
        } else if (mute < new Date().getTime()) {
            mute = new Date().getTime() + time
        } else {
            mute = mute + time
        }
        lock.mute = mute
    }

    async muteAtLeast(session: Session, time: number) {
        const groupId = session.guildId
        await this._lockByGroupId(groupId)
        try {
            const groupLock = this._getGroupLocks(groupId)
            groupLock.mute = Math.max(groupLock.mute ?? 0, Date.now() + time)
        } finally {
            this._unlockByGroupId(groupId)
        }
    }

    collect(func: (session: Session, messages: Message[]) => Promise<void>) {
        this.ctx.on('chatluna_character/message_collect', func)
    }

    getMessages(groupId: string, botId: string): Message[] | undefined
    getMessages(groupId: string): Record<string, Message[]> | undefined
    getMessages(groupId: string, botId?: string) {
        if (botId) {
            return this._messages[groupId]?.[botId]
        }
        return this._messages[groupId]
    }

    isMute(session: Session) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const lock = this._getGroupLocks(session.guildId, botId)

        return lock.mute > new Date().getTime()
    }

    isResponseLocked(session: Session) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const lock = this._getGroupLocks(session.guildId, botId)
        return lock.responseLock
    }

    /**
     * Try to acquire the response lock. If the lock is already held, wait until it is released.
     * @returns A Promise that resolves to whether the lock was successfully acquired (false means cancelled)
     */
    async acquireResponseLock(
        session: Session,
        message: Message
    ): Promise<boolean> {
        const groupId = session.guildId
        const botId = `${session.bot.platform}:${session.bot.selfId}`

        await this._lockByGroupId(groupId, botId)

        const lock = this._getGroupLocks(groupId, botId)

        if (!lock.responseLock) {
            lock.responseLock = true
            this._unlockByGroupId(groupId, botId)
            return true
        }

        // Lock is held, create waiter while holding mutex
        const botGuildKey = `${groupId}:${botId}`
        const waiterPromise = new Promise<boolean>((resolve) => {
            if (!this._responseWaiters[botGuildKey]) {
                this._responseWaiters[botGuildKey] = []
            }
            this._responseWaiters[botGuildKey].push({
                resolve: () => resolve(true),
                reject: () => resolve(false)
            })
        })

        this._unlockByGroupId(groupId, botId)

        return waiterPromise
    }

    setResponseLock(session: Session) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const lock = this._getGroupLocks(session.guildId, botId)
        lock.responseLock = true
    }

    async releaseResponseLock(session: Session) {
        const groupId = session.guildId
        const botId = `${session.bot.platform}:${session.bot.selfId}`

        await this._lockByGroupId(groupId, botId)

        try {
            const lock = this._getGroupLocks(groupId, botId)

            const botGuildKey = `${groupId}:${botId}`
            const waiters = this._responseWaiters[botGuildKey]
            lock.responseLock = false

            if (waiters && waiters.length > 0) {
                // Cancel all old waiters, only wake up the latest one
                const latestWaiter = waiters.pop()
                for (const waiter of waiters) {
                    waiter.reject()
                }
                this._responseWaiters[botGuildKey] = []

                if (latestWaiter) {
                    lock.responseLock = true
                    latestWaiter.resolve()
                }
            }
        } finally {
            this._unlockByGroupId(groupId, botId)
        }
    }

    async cancelPendingWaiters(groupId: string) {
        // 注意：此方法不支持 botId 参数，取消所有 bot 的等待
        await this._lockByGroupId(groupId, undefined)

        try {
            // 取消所有 bot 的等待
            for (const botGuildKey of Object.keys(this._responseWaiters)) {
                if (botGuildKey.startsWith(groupId + ':')) {
                    const waiters = this._responseWaiters[botGuildKey]
                    if (waiters) {
                        for (const waiter of waiters) {
                            waiter.reject('cancelled')
                        }
                        this._responseWaiters[botGuildKey] = []
                    }
                }
            }
        } finally {
            this._unlockByGroupId(groupId, undefined)
        }
    }

    async updateTemp(session: Session, temp: GroupTemp) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        await this._lock(session, botId)

        const groupId = session.guildId

        if (!this._groupTemp[groupId]) {
            this._groupTemp[groupId] = {}
        }
        this._groupTemp[groupId][botId] = temp

        await this._unlock(session, botId)
    }

    async getTemp(session: Session): Promise<GroupTemp> {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        await this._lock(session, botId)

        const groupId = session.guildId

        const groupTemp = this._getGroupTemp(groupId, botId)
        const temp = groupTemp ?? {
            completionMessages: []
        }

        this._groupTemp[groupId][botId] = temp

        await this._unlock(session, botId)

        return temp
    }

    private _getGroupTemp(groupId: string, botId: string) {
        if (!this._groupTemp[groupId]) {
            this._groupTemp[groupId] = {}
        }
        if (!this._groupTemp[groupId][botId]) {
            this._groupTemp[groupId][botId] = {
                completionMessages: []
            }
        }
        return this._groupTemp[groupId][botId]
    }

    private _getGroupLocks(groupId: string, botId?: string) {
        if (!this._groupLocks[groupId]) {
            this._groupLocks[groupId] = {}
        }
        const botKey = botId ?? 'default'
        if (!this._groupLocks[groupId][botKey]) {
            this._groupLocks[groupId][botKey] = {
                lock: false,
                mute: 0,
                responseLock: false
            }
        }
        return this._groupLocks[groupId][botKey]
    }

    private _getGroupConfig(groupId: string) {
        const config = this._config
        if (!config.configs[groupId]) {
            return config
        }
        return Object.assign({}, config, config.configs[groupId])
    }

    private _lock(session: Session, botId?: string) {
        const groupLock = this._getGroupLocks(session.guildId, botId)
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (!groupLock.lock) {
                    groupLock.lock = true
                    clearInterval(interval)
                    resolve()
                }
            }, 100)
        })
    }

    private _unlock(session: Session, botId?: string) {
        const groupLock = this._getGroupLocks(session.guildId, botId)
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (groupLock.lock) {
                    groupLock.lock = false
                    clearInterval(interval)
                    resolve()
                }
            }, 100)
        })
    }

    private _lockByGroupId(groupId: string, botId?: string) {
        const groupLock = this._getGroupLocks(groupId, botId)
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (!groupLock.lock) {
                    groupLock.lock = true
                    clearInterval(interval)
                    resolve()
                }
            }, 100)
        })
    }

    private _unlockByGroupId(groupId: string, botId?: string) {
        const groupLock = this._getGroupLocks(groupId, botId)
        groupLock.lock = false
    }

    async clear(groupId?: string) {
        if (groupId) {
            await this._lockByGroupId(groupId, undefined)
            try {
                this._messages[groupId] = {}
                // 清除该群组下所有 bot 的临时状态
                this._groupTemp[groupId] = {}
                // Cancel waiters directly while holding lock (for all bots in this group)
                for (const botGuildKey of Object.keys(this._responseWaiters)) {
                    if (botGuildKey.startsWith(groupId + ':')) {
                        const waiters = this._responseWaiters[botGuildKey]
                        if (waiters) {
                            for (const waiter of waiters) {
                                waiter.reject('cancelled')
                            }
                            this._responseWaiters[botGuildKey] = []
                        }
                    }
                }
            } finally {
                this._unlockByGroupId(groupId, undefined)
            }
            return
        }

        // For clear-all, acquire locks in sorted order to prevent deadlocks
        const groupIds = Object.keys(this._groupLocks).sort()
        for (const gid of groupIds) {
            await this._lockByGroupId(gid, undefined)
        }

        try {
            this._messages = {}
            this._groupTemp = {}

            // Cancel waiters directly while holding locks
            for (const botGuildKey of Object.keys(this._responseWaiters)) {
                const waiters = this._responseWaiters[botGuildKey]
                if (waiters) {
                    for (const waiter of waiters) {
                        waiter.reject('cancelled')
                    }
                    this._responseWaiters[botGuildKey] = []
                }
            }
        } finally {
            // Release in reverse order
            for (let i = groupIds.length - 1; i >= 0; i--) {
                this._unlockByGroupId(groupIds[i], undefined)
            }
        }
    }

    async broadcastOnBot(session: Session, elements: h[]) {
        if (session.isDirect) {
            return
        }

        const content = mapElementToString(session, session.content, elements)

        if (content.length < 1) {
            return
        }

        const message: Message = {
            content,
            name: session.bot.user.name,
            id: session.bot.selfId ?? '0',
            messageId: session.messageId,
            timestamp: session.event.timestamp
        }

        await this._addMessage(session, message)
    }

    async broadcast(session: Session) {
        if (session.isDirect) {
            return
        }

        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId

        this.logger.info(
            `[MessageCollector] 收集消息 - Bot: ${botId}, Guild: ${groupId}`
        )

        const config = this._getGroupConfig(groupId)

        const images = config.image
            ? await getImages(this.ctx, config.model, session)
            : undefined

        const elements = session.elements
            ? session.elements
            : [h.text(session.content)]

        const content = mapElementToString(
            session,
            session.content,
            elements,
            images
        )

        this.logger.debug(
            `[MessageCollector] 消息内容: ${content.length > 100 ? content.slice(0, 100) + '...' : content}`
        )

        if (content.length < 1) {
            this.logger.debug(`[MessageCollector] 消息内容为空，跳过`)
            return
        }

        const message: Message = {
            content,
            name: getNotEmptyString(
                session.author?.nick,
                session.author?.name,
                session.event.user?.name,
                session.username
            ),
            id: session.author.id,
            messageId: session.messageId,
            timestamp: session.event.timestamp,
            quote: session.quote
                ? {
                      content: mapElementToString(
                          session,
                          session.quote.content,
                          session.quote.elements ?? [
                              h.text(session.quote.content)
                          ]
                      ),
                      name: session.quote?.user?.name,
                      id: session.quote?.user?.id,
                      messageId: session.quote.id
                  }
                : undefined,
            images
        }

        const shouldTrigger = await this._addMessage(session, message, {
            filterExpiredMessages: true,
            processImages: config
        })

        this.logger.info(
            `[MessageCollector] shouldTrigger: ${shouldTrigger}, isMute: ${this.isMute(session)}`
        )

        if (shouldTrigger && !this.isMute(session)) {
            const acquired = await this.acquireResponseLock(session, message)
            if (!acquired) {
                // Cancelled, do not trigger
                this.logger.debug(`[MessageCollector] 响应锁获取失败（已取消）`)
                return false
            }
            // 获取当前 bot 的消息历史
            const messages = this._messages[groupId]?.[botId] ?? []
            this.logger.info(
                `[MessageCollector] 触发消息收集事件 - Bot: ${botId}, Guild: ${groupId}, 历史消息数: ${messages.length}`
            )
            await this.ctx.parallel(
                'chatluna_character/message_collect',
                session,
                messages
            )
            return true
        } else {
            this.logger.debug(
                `[MessageCollector] 不触发响应 - shouldTrigger: ${shouldTrigger}, isMute: ${this.isMute(session)}`
            )
            return this.isMute(session)
        }
    }

    private async _addMessage(
        session: Session,
        message: Message,
        options?: {
            filterExpiredMessages?: boolean
            processImages?: Config
        }
    ): Promise<boolean> {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        await this._lock(session, botId)

        try {
            const groupId = session.guildId
            const maxMessageSize = this._config.maxMessages

            // 按 botId 存储消息
            if (!this._messages[groupId]) {
                this._messages[groupId] = {}
            }
            let groupArray = this._messages[groupId][botId] ?? []

            this.logger.debug(
                `[MessageCollector] 添加消息前 - Bot: ${botId}, Guild: ${groupId}, 消息数: ${groupArray.length}`
            )

            groupArray.push(message)

            while (groupArray.length > maxMessageSize) {
                groupArray.shift()
            }

            this.logger.debug(
                `[MessageCollector] 添加消息后 - 消息数: ${groupArray.length} (max: ${maxMessageSize})`
            )

            if (options?.filterExpiredMessages) {
                const beforeFilter = groupArray.length
                const now = Date.now()
                groupArray = groupArray.filter((msg) => {
                    return (
                        msg.timestamp == null ||
                        msg.timestamp >= now - Time.hour
                    )
                })
                this.logger.debug(
                    `[MessageCollector] 过期消息过滤 - 前: ${beforeFilter}, 后: ${groupArray.length}`
                )
            }

            if (options?.processImages) {
                await this._processImages(groupArray, options.processImages)
            }

            this._messages[groupId][botId] = groupArray

            const filterResult = this._filters.some((func) =>
                func(session, message)
            )
            this.logger.debug(`[MessageCollector] 过滤器结果: ${filterResult}`)

            return filterResult
        } finally {
            await this._unlock(session, botId)
        }
    }

    private async _processImages(groupArray: Message[], config: Config) {
        if (!config.image) return

        const maxCount = config.imageInputMaxCount || 3
        const maxSize =
            config.imageInputMaxSize * 1024 * 1024 || 1024 * 1024 * 10

        let currentCount = 0
        let currentSize = 0

        for (let i = groupArray.length - 1; i >= 0; i--) {
            const message = groupArray[i]
            if (!message.images || message.images.length === 0) continue

            const validImages: Awaited<ReturnType<typeof getImages>> = []

            for (const image of message.images) {
                const imageSize = await this._getImageSize(image.url)

                if (
                    currentCount < maxCount &&
                    currentSize + imageSize <= maxSize
                ) {
                    validImages.push(image)
                    currentCount++
                    currentSize += imageSize
                } else {
                    break
                }
            }

            if (validImages.length === 0) {
                delete message.images
            } else {
                message.images = validImages
            }

            if (currentCount >= maxCount || currentSize >= maxSize) {
                for (let j = i - 1; j >= 0; j--) {
                    if (groupArray[j].images) {
                        delete groupArray[j].images
                    }
                }
                break
            }
        }
    }

    private async _getImageSize(base64Image: string): Promise<number> {
        try {
            if (!base64Image.startsWith('data:')) {
                const resp = await this.ctx.http.get(base64Image, {
                    responseType: 'arraybuffer'
                })
                return resp.byteLength
            }
            const base64Data = base64Image.replace(
                /^data:image\/[a-z]+;base64,/,
                ''
            )
            return Math.ceil((base64Data.length * 3) / 4)
        } catch (e) {
            this.logger.error(e, base64Image)
            return 0
        }
    }
}

function mapElementToString(
    session: Session,
    content: string,
    elements: h[],
    images?: MessageImage[]
) {
    const filteredBuffer: string[] = []
    const usedImages = new Set<string>()

    for (const element of elements) {
        if (element.type === 'text') {
            const content = element.attrs.content as string

            if (content?.trimEnd()?.length > 0) {
                filteredBuffer.push(content)
            }
        } else if (element.type === 'at') {
            let name = element.attrs?.name
            if (element.attrs.id === session.bot.selfId) {
                name = name ?? session.bot.user.name ?? '0'
            }
            if (name == null || name.length < 1) {
                name = element.attrs.id ?? '0'
            }

            filteredBuffer.push(`<at name='${name}'>${element.attrs.id}</at>`)
        } else if (element.type === 'img') {
            const imageHash = element.attrs.imageHash as string | undefined
            const imageUrl = element.attrs.imageUrl as string | undefined

            const matchedImage = images?.find((image) => {
                if (imageHash && image.hash === imageHash) {
                    return true
                }
                if (imageUrl && image.url === imageUrl) {
                    return true
                }
                return false
            })

            if (imageUrl) {
                filteredBuffer.push(`<sticker>${imageUrl}</sticker>`)
            } else if (matchedImage) {
                filteredBuffer.push(matchedImage.formatted)
                usedImages.add(matchedImage.formatted)
            } else if (images && images.length > 0) {
                for (const image of images) {
                    if (!usedImages.has(image.formatted)) {
                        filteredBuffer.push(image.formatted)
                        usedImages.add(image.formatted)
                    }
                }
            } else {
                let buffer = `[image`
                if (imageHash) {
                    buffer += `:${imageHash}`
                }
                if (imageUrl) {
                    buffer += `:${imageUrl}`
                }
                buffer += ']'
                filteredBuffer.push(buffer)
            }
        } else if (element.type === 'face') {
            filteredBuffer.push(
                `<face name='${element.attrs.name}'>${element.attrs.id}</face>`
            )
        } else if (element.type === 'file') {
            const url = element.attrs['chatluna_file_url']
            if (!url) {
                continue
            }
            const name = element.attrs['file'] ?? element.attrs['name']

            filteredBuffer.push(`[file:${name}:${url}]`)
        }
    }

    if (content.trimEnd().length < 1 && filteredBuffer.length < 1) {
        return ''
    }

    return filteredBuffer.join('')
}

// 返回 base64 的图片编码
async function getImages(ctx: Context, model: string, session: Session) {
    const mergedMessage = await ctx.chatluna.messageTransformer.transform(
        session,
        session.elements,
        model
    )

    if (typeof mergedMessage.content === 'string') {
        return undefined
    }

    const images = mergedMessage.content.filter(isMessageContentImageUrl)

    if (!images || images.length < 1) {
        return undefined
    }

    const results: MessageImage[] = []

    for (const image of images) {
        const url =
            typeof image.image_url === 'string'
                ? image.image_url
                : image.image_url.url

        let hash: string =
            typeof image.image_url !== 'string' ? image.image_url['hash'] : ''

        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            hash = await hashString(url, 8)
        }

        const formatted = hash ? `[image:${hash}]` : `<sticker>${url}</sticker>`

        results.push({ url, hash, formatted })
    }

    return results
}

export function getNotEmptyString(...texts: (string | undefined)[]): string {
    for (const text of texts) {
        if (text && text?.length > 0) {
            return text
        }
    }
}
