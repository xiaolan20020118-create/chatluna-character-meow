import { MessageCollector } from './service/message'
import { BotConfig, Message } from './types'

declare module 'koishi' {
    export interface Context {
        // 移除 chatluna 服务的重复声明，使用 chatluna_dify_meow 已有的声明
        // 仅声明 chatluna_character 独有的服务
        chatluna_character: MessageCollector & {
            botConfig: {
                setBotConfig(botId: string, config: BotConfig): void
                getBotConfig(botId: string): BotConfig | undefined
                hasBotConfig(botId: string): boolean
                clearBotConfig(botId: string): void
                getAllConfigs(): Record<string, BotConfig>
            }
        }
    }

    export interface Events {
        // 移除 chatluna/before-check-sender 的重复声明
        'chatluna_character/message_collect': (
            session: import('koishi').Session,
            message: Message[]
        ) => void | Promise<void>
        'chatluna_character/preset_updated': () => void
        'chatluna_character/ready': () => void
        'chatluna_character/bot-config-updated': (
            botId: string,
            config: BotConfig,
            oldConfig: BotConfig | undefined
        ) => void | Promise<void>
    }
}
