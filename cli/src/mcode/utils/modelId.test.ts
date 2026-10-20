import { describe, expect, it } from 'vitest';
import { acpModelIdToCliModelId } from './modelId';

describe('acpModelIdToCliModelId', () => {
    it('converts a wire id with a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3:v:thinking'))
            .toBe('minimax/MiniMax-M3#thinking');
    });

    it('converts a wire id without a variant', () => {
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3:u'))
            .toBe('minimax/MiniMax-M3');
        expect(acpModelIdToCliModelId('m:minimax:MiniMax-M3.1-Flash:v:'))
            .toBe('minimax/MiniMax-M3.1-Flash');
    });

    it('decodes URI-encoded wire ids back to the CLI form', () => {
        expect(acpModelIdToCliModelId('m:my%20provider:anthropic%2Fclaude-sonnet-4:v:thinking%20hard'))
            .toBe('my provider/anthropic/claude-sonnet-4#thinking hard');
        expect(acpModelIdToCliModelId('m:minimax:model%2Bplus:u'))
            .toBe('minimax/model+plus');
    });

    it('returns null for ids the CLI would reject', () => {
        expect(acpModelIdToCliModelId('minimax/MiniMax-M3')).toBeNull();
        // A provider cannot contain `/` in the CLI grammar.
        expect(acpModelIdToCliModelId('m:pro%2Fvider:model:u')).toBeNull();
        // `#` is the variant separator and cannot be escaped in the CLI form.
        expect(acpModelIdToCliModelId('m:minimax:model%23x:u')).toBeNull();
        expect(acpModelIdToCliModelId('m:minimax:model:v:variant%23x')).toBeNull();
        // `u` has no variant suffix and `v` always has one.
        expect(acpModelIdToCliModelId('m:minimax:model:u:')).toBeNull();
        expect(acpModelIdToCliModelId('m:minimax:model:v')).toBeNull();
        // Extra segments are not part of the wire format.
        expect(acpModelIdToCliModelId('m:minimax:model:v:one:two')).toBeNull();
        // Malformed percent escapes are rejected instead of passed through.
        expect(acpModelIdToCliModelId('m:minimax:%E0%A4%A:u')).toBeNull();
        expect(acpModelIdToCliModelId('')).toBeNull();
        expect(acpModelIdToCliModelId(null)).toBeNull();
        expect(acpModelIdToCliModelId(undefined)).toBeNull();
    });
});
