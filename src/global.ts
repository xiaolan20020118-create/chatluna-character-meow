import { MessageCollector } from './service/message'
import { BotConfig, Message } from './types'

declare module 'koishi' {
    export interface Context {
        // ChatLuna 服务（来自 koishi-plugin-chatluna）
        chatluna: {
            createChatModel(platform: string, modelName: string): Promise<any>
            createEmbeddings(platform: string, modelName: string): Promise<any>
            preset?: any
            platform?: any
            config?: any
            promptRenderer?: any
            messageTransformer?: any
        }

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
        'chatluna/before-check-sender': (
            session: import('koishi').Session
        ) => boolean | void | Promise<boolean | void>
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
