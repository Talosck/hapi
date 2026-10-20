import { describe, expect, it } from 'vitest';
import { extractMcodeModelsFromResponse } from './mcodeModels';

describe('extractMcodeModelsFromResponse', () => {
    it('reads the catalog from the model config option', () => {
        const { availableModels, currentModelId } = extractMcodeModelsFromResponse({
            configOptions: [
                {
                    id: 'permissionMode',
                    category: '_permission',
                    currentValue: 'default',
                    options: [{ value: 'default', name: 'Ask' }]
                },
                {
                    id: 'model',
                    category: 'model',
                    currentValue: 'm:minimax:MiniMax-M3:v:thinking',
                    options: [
                        { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
                        { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' }
                    ]
                }
            ]
        });

        expect(currentModelId).toBe('m:minimax:MiniMax-M3:v:thinking');
        expect(availableModels).toEqual([
            { modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
            { modelId: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' }
        ]);
    });

    it('falls back to the direct model list when the agent publishes one', () => {
        const { availableModels, currentModelId } = extractMcodeModelsFromResponse({
            availableModels: [{ modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' }],
            currentModelId: 'm:minimax:MiniMax-M3:v:'
        });

        expect(currentModelId).toBe('m:minimax:MiniMax-M3:v:');
        expect(availableModels).toEqual([{ modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' }]);
    });

    it('returns an empty catalog for an unexpected response', () => {
        expect(extractMcodeModelsFromResponse(null))
            .toEqual({ availableModels: [], currentModelId: null });
        expect(extractMcodeModelsFromResponse({ configOptions: [] }))
            .toEqual({ availableModels: [], currentModelId: null });
    });
});
