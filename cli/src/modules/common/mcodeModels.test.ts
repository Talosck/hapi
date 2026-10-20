import { describe, expect, it } from 'vitest';
import { extractMcodeModelsFromResponse } from './mcodeModels';

describe('extractMcodeModelsFromResponse', () => {
    it('reads the model and effort catalogs from the config options', () => {
        const { availableModels, currentModelId, effortOptions, currentEffort } = extractMcodeModelsFromResponse({
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
                },
                {
                    id: 'thinkingEffort',
                    category: 'thought_level',
                    currentValue: 'max',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'max', name: 'Max' }
                    ]
                }
            ]
        });

        expect(currentModelId).toBe('m:minimax:MiniMax-M3:v:thinking');
        expect(availableModels).toEqual([
            { modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
            { modelId: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' }
        ]);
        expect(currentEffort).toBe('max');
        expect(effortOptions).toEqual([
            { value: 'low', name: 'Low' },
            { value: 'max', name: 'Max' }
        ]);
    });

    it('normalizes the ACP default effort to the absence of a level', () => {
        const { currentEffort, effortOptions } = extractMcodeModelsFromResponse({
            configOptions: [
                {
                    id: 'thinkingEffort',
                    category: 'thought_level',
                    currentValue: 'default',
                    options: [
                        { value: 'default', name: 'Default' },
                        { value: 'low', name: 'Low' }
                    ]
                }
            ]
        });

        expect(currentEffort).toBeNull();
        expect(effortOptions).toEqual([{ value: 'low', name: 'Low' }]);
    });

    it('falls back to the direct model list when the agent publishes one', () => {
        const { availableModels, currentModelId, effortOptions, currentEffort } = extractMcodeModelsFromResponse({
            availableModels: [{ modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' }],
            currentModelId: 'm:minimax:MiniMax-M3:v:'
        });

        expect(currentModelId).toBe('m:minimax:MiniMax-M3:v:');
        expect(availableModels).toEqual([{ modelId: 'm:minimax:MiniMax-M3:v:', name: 'M3' }]);
        expect(effortOptions).toEqual([]);
        expect(currentEffort).toBeNull();
    });

    it('returns an empty catalog for an unexpected response', () => {
        expect(extractMcodeModelsFromResponse(null)).toEqual({
            availableModels: [],
            currentModelId: null,
            effortOptions: [],
            currentEffort: null
        });
        expect(extractMcodeModelsFromResponse({ configOptions: [] })).toEqual({
            availableModels: [],
            currentModelId: null,
            effortOptions: [],
            currentEffort: null
        });
    });
});
