import { describe, expect, it } from 'vitest';
import { acpModelIdToCliModelId } from './modelId';

describe('acpModelIdToCliModelId', () => {
    it('converts a wire id with a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3:v:thinking'))
            .toBe('minimax/MiniMax-M3#thinking');
    });

    it('converts a wire id without a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3.1-Flash:v:'))
            .toBe('minimax/MiniMax-M3.1-Flash');
    });

    it('returns null for ids the CLI would reject', () => {
        expect(acpModelIdToCliModelId('minimax/MiniMax-M3')).toBeNull();
        expect(acpModelIdToCliModelId('')).toBeNull();
        expect(acpModelIdToCliModelId(null)).toBeNull();
        expect(acpModelIdToCliModelId(undefined)).toBeNull();
    });
});
