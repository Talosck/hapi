import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from '@/chat/reducer'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { buildMessageMetadataLabels } from '@/components/AssistantChat/messages/MessageMetadata'
import type { RoundSummary } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'

/**
 * The remote (SDK) path of a Claude turn, exactly as the hub stores it.
 *
 * Every assistant frame of the turn reports an all-zero usage block, and the
 * turn's real usage only arrives on the result frame, which the CLI turns
 * into a `turn_duration` message.
 */
const turnFrames = [
    {
        id: 'frame-1',
        seq: 2,
        createdAt: 1_700_000_000_000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'u1',
                    parentUuid: null,
                    isSidechain: false,
                    message: {
                        content: [{ type: 'text', text: 'working' }],
                        id: 'msg_1',
                        model: 'minimax/MiniMax-M3.1-Flash',
                        role: 'assistant',
                        usage: { input_tokens: 0, output_tokens: 0, context_window: 1_000_000 }
                    }
                }
            }
        }
    },
    {
        id: 'frame-2',
        seq: 3,
        createdAt: 1_700_000_001_000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    uuid: 'turn-uuid',
                    parentUuid: null,
                    isSidechain: false,
                    durationMs: 46_731,
                    resultSummary: {
                        usage: {
                            input_tokens: 2_023,
                            output_tokens: 1_312,
                            cache_read_input_tokens: 1_183_507,
                            cache_creation_input_tokens: 0
                        },
                        modelUsage: {
                            'minimax/MiniMax-M3.1-Flash[1m]': {
                                inputTokens: 2_023,
                                outputTokens: 1_312,
                                cacheReadInputTokens: 1_183_507,
                                cacheCreationInputTokens: 0,
                                contextWindow: 1_000_000,
                                costUSD: 13.44
                            }
                        },
                        total_cost_usd: 13.44,
                        num_turns: 8,
                        duration_ms: 46_731
                    }
                }
            }
        }
    }
] as unknown as DecryptedMessage[]

describe('a Claude turn that reports its usage on the result frame', () => {
    it('shows the context usage in the status bar', () => {
        const normalized = turnFrames
            .map((message) => normalizeDecryptedMessage(message))
            .filter((message): message is NonNullable<typeof message> => message !== null)

        const reduced = reduceChatBlocks(normalized, null)

        // The status bar reads these three: the numerator, the cache it holds
        // and the window it is measured against.
        expect(reduced.latestUsage).toMatchObject({
            contextSize: 1_185_530,
            cacheRead: 1_183_507,
            contextWindow: 1_000_000
        })
    })

    it('shows the model, the tokens and the cost in the message footer', () => {
        const normalized = turnFrames
            .map((message) => normalizeDecryptedMessage(message))
            .filter((message): message is NonNullable<typeof message> => message !== null)

        const summary = normalized
            .map((message) => message.content)
            .filter((content): content is { type: 'turn-summary'; summary: RoundSummary } =>
                typeof content === 'object' && content !== null && 'type' in content && content.type === 'turn-summary'
            )
            .map((content) => content.summary)[0]

        const labels = buildMessageMetadataLabels({ roundSummary: summary })

        expect(labels.some((label) => label.includes('minimax/MiniMax-M3.1-Flash'))).toBe(true)
        expect(labels.some((label) => label.includes('Cost:'))).toBe(true)
    })
})
