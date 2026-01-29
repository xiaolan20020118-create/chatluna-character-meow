import { MessageCollector } from './service/message'
import { BotConfig, Message } from './types'

declare module 'koishi' {
    export interface Context {
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
        'chatluna_character/message_collect': (
            session: import('koishi').Session,
            message: Message[]
        ) => void | Promise<void>
        'chatluna_character/preset_updated': () => void
        'chatluna_character/ready': () => void
    }
}
