// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Config } from '..'
import { Preset } from '../preset'
import {
    BotConfig,
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
 * 互斥锁 - 用于保护共享状态访问
 */
class Mutex {
    private _locked = false
    private _waiters: (() => void)[] = []

    async acquire(): Promise<void> {
        if (!this._locked) {
            this._locked = true
            return
        }

        return new Promise<void>((resolve) => {
            this._waiters.push(resolve)
        })
    }

    release(): void {
        const next = this._waiters.shift()
        if (next) {
            next()
        } else {
            this._locked = false
        }
    }
}

/**
 * 响应锁 - 控制响应顺序
 * 只保留最新的等待者，其他的会被取消
 */
class ResponseLock {
    private _locked = false
    private _waiters: {
        resolve: (value: boolean) => void
        reject: (value: boolean) => void
    }[] = []

    async acquire(): Promise<boolean> {
        if (!this._locked) {
            this._locked = true
            return true
        }

        return new Promise<boolean>((resolve) => {
            this._waiters.push({
                resolve: (value: boolean) => resolve(value),
                reject: () => resolve(false)
            })
        })
    }

    release(): void {
        const latest = this._waiters.pop()

        // 取消所有旧的等待者，只唤醒最新的一个
        for (const waiter of this._waiters) {
            waiter.reject(false)
        }
        this._waiters = []

        if (latest) {
            this._locked = true
            latest.resolve(true)
        } else {
            this._locked = false
        }
    }

    cancelAll(): void {
        for (const waiter of this._waiters) {
            waiter.reject(false)
        }
        this._waiters = []
        this._locked = false
    }
}

/**
 * 统一锁管理器
 */
class LockManager {
    private _mutexes: Map<string, Mutex> = new Map()
    private _responseLocks: Map<string, ResponseLock> = new Map()

    async acquireMutex(guildId: string, botId: string): Promise<void> {
        const key = `${guildId}:${botId}`
        let mutex = this._mutexes.get(key)
        if (!mutex) {
            mutex = new Mutex()
            this._mutexes.set(key, mutex)
        }
        await mutex.acquire()
    }

    releaseMutex(guildId: string, botId: string): void {
        const key = `${guildId}:${botId}`
        const mutex = this._mutexes.get(key)
        if (mutex) {
            mutex.release()
        }
    }

    async acquireResponseLock(
        guildId: string,
        botId: string
    ): Promise<boolean> {
        await this.acquireMutex(guildId, botId)

        try {
            const key = `${guildId}:${botId}`
            let responseLock = this._responseLocks.get(key)

            if (!responseLock) {
                responseLock = new ResponseLock()
                this._responseLocks.set(key, responseLock)
            }

            return await responseLock.acquire()
        } finally {
            this.releaseMutex(guildId, botId)
        }
    }

    async releaseResponseLock(guildId: string, botId: string): Promise<void> {
        await this.acquireMutex(guildId, botId)

        try {
            const key = `${guildId}:${botId}`
            const responseLock = this._responseLocks.get(key)
            if (responseLock) {
                responseLock.release()
            }
        } finally {
            this.releaseMutex(guildId, botId)
        }
    }

    async cancelResponseWaiters(guildId: string): Promise<void> {
        const prefix = `${guildId}:`
        const keysToCancel: string[] = []

        for (const key of this._responseLocks.keys()) {
            if (key.startsWith(prefix)) {
                keysToCancel.push(key)
            }
        }

        keysToCancel.sort()

        for (const key of keysToCancel) {
            const [, botId] = key.split(':')
            await this.acquireMutex(guildId, botId)
        }

        try {
            for (const key of keysToCancel) {
                const responseLock = this._responseLocks.get(key)
                if (responseLock) {
                    responseLock.cancelAll()
                }
            }
        } finally {
            for (const key of keysToCancel) {
                const [, botId] = key.split(':')
                this.releaseMutex(guildId, botId)
            }
        }
    }

    clearGuild(guildId: string): void {
        for (const key of this._mutexes.keys()) {
            if (key.startsWith(`${guildId}:`)) {
                this._mutexes.delete(key)
            }
        }

        for (const key of this._responseLocks.keys()) {
            if (key.startsWith(`${guildId}:`)) {
                this._responseLocks.delete(key)
            }
        }
    }

    dispose(): void {
        this._mutexes.clear()
        this._responseLocks.clear()
    }
}

/**
 * Bot 配置服务，允许外部插件注册和管理每个 bot 的配置
 */
class BotConfigService {
    private _botConfigs: Record<string, BotConfig> = {}
    private _ctx: Context

    constructor(ctx: Context) {
        this._ctx = ctx
    }

    setBotConfig(botId: string, config: BotConfig) {
        const oldConfig = this._botConfigs[botId]
        this._botConfigs[botId] = config
        // 触发配置更新事件，使 character 插件可以重新加载模型池
        this._ctx.emit(
            'chatluna_character/bot-config-updated',
            botId,
            config,
            oldConfig
        )
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

    // Mute 状态按 botId 隔离（不再需要 lock 和 responseLock）
    private _muteStates: Record<string, Record<string, { mute: number }>> = {}

    // 多 bot 支持：临时状态也按 botId 隔离
    private _groupTemp: Record<string, Record<string, GroupTemp>> = {}

    // 统一锁管理器
    private _lockManager: LockManager

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
        this.botConfig = new BotConfigService(ctx)
        this._lockManager = new LockManager()
    }

    addFilter(filter: MessageCollectorFilter) {
        this._filters.push(filter)
    }

    mute(session: Session, time: number) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const muteState = this._getMuteState(session.guildId, botId)

        if (time === 0) {
            muteState.mute = 0
        } else if (muteState.mute < new Date().getTime()) {
            muteState.mute = new Date().getTime() + time
        } else {
            muteState.mute = muteState.mute + time
        }
    }

    async muteAtLeast(session: Session, time: number) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId
        await this._lockManager.acquireMutex(groupId, botId)
        try {
            const muteState = this._getMuteState(groupId, botId)
            muteState.mute = Math.max(muteState.mute ?? 0, Date.now() + time)
        } finally {
            this._lockManager.releaseMutex(groupId, botId)
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
        const muteState = this._getMuteState(session.guildId, botId)
        return muteState.mute > new Date().getTime()
    }

    /**
     * Try to acquire the response lock. If the lock is already held, wait until it is released.
     * @returns A Promise that resolves to whether the lock was successfully acquired (false means cancelled)
     */
    async acquireResponseLock(
        session: Session,
        message: Message
    ): Promise<boolean> {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId
        return this._lockManager.acquireResponseLock(groupId, botId)
    }

    async releaseResponseLock(session: Session) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId
        await this._lockManager.releaseResponseLock(groupId, botId)
    }

    async cancelPendingWaiters(groupId: string) {
        await this._lockManager.cancelResponseWaiters(groupId)
    }

    async updateTemp(session: Session, temp: GroupTemp) {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId

        await this._lockManager.acquireMutex(groupId, botId)
        try {
            if (!this._groupTemp[groupId]) {
                this._groupTemp[groupId] = {}
            }
            this._groupTemp[groupId][botId] = temp
        } finally {
            this._lockManager.releaseMutex(groupId, botId)
        }
    }

    async getTemp(session: Session): Promise<GroupTemp> {
        const botId = `${session.bot.platform}:${session.bot.selfId}`
        const groupId = session.guildId

        await this._lockManager.acquireMutex(groupId, botId)
        try {
            const groupTemp = this._getGroupTemp(groupId, botId)
            const temp = groupTemp ?? {
                completionMessages: []
            }

            this._groupTemp[groupId][botId] = temp

            return temp
        } finally {
            this._lockManager.releaseMutex(groupId, botId)
        }
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

    private _getMuteState(groupId: string, botId: string) {
        if (!this._muteStates[groupId]) {
            this._muteStates[groupId] = {}
        }
        if (!this._muteStates[groupId][botId]) {
            this._muteStates[groupId][botId] = { mute: 0 }
        }
        return this._muteStates[groupId][botId]
    }

    private _getGroupConfig(groupId: string) {
        const config = this._config
        if (!config.configs[groupId]) {
            return config
        }
        return Object.assign({}, config, config.configs[groupId])
    }

    async clear(groupId?: string) {
        if (groupId) {
            // Clear specific group
            this._messages[groupId] = {}
            this._groupTemp[groupId] = {}
            this._lockManager.clearGuild(groupId)
            return
        }

        // Clear all
        this._messages = {}
        this._groupTemp = {}
        this._muteStates = {}
        this._lockManager.dispose()
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
        const groupId = session.guildId

        await this._lockManager.acquireMutex(groupId, botId)

        try {
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
            this._lockManager.releaseMutex(groupId, botId)
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
