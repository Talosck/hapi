import { describe, expect, it } from 'vitest';
import { buildMcodeLocalArgs } from './mcodeLocal';

describe('buildMcodeLocalArgs', () => {
    it('reopens the native session when the id is known', () => {
        expect(buildMcodeLocalArgs({ sessionId: 'mvs_abc' })).toEqual(['--session', 'mvs_abc']);
    });

    it('starts a fresh TUI when no session id is known', () => {
        expect(buildMcodeLocalArgs({ sessionId: null })).toEqual([]);
    });

    it('translates the ACP wire model id into the CLI model id', () => {
        expect(buildMcodeLocalArgs({
            sessionId: 'mvs_abc',
            model: 'm:minimax:MiniMax-M3:v:thinking'
        })).toEqual(['--session', 'mvs_abc', '--model', 'minimax/MiniMax-M3#thinking']);
        expect(buildMcodeLocalArgs({
            sessionId: 'mvs_abc',
            model: 'm:minimax:MiniMax-M3:u'
        })).toEqual(['--session', 'mvs_abc', '--model', 'minimax/MiniMax-M3']);
    });

    it('passes a model the user named the CLI way on unchanged', () => {
        // The MiniMax CLI itself takes `provider/model[#variant]`, so a model
        // the user named that way is what the TUI expects.
        expect(buildMcodeLocalArgs({ model: 'minimax/MiniMax-M3' }))
            .toEqual(['--model', 'minimax/MiniMax-M3']);
        expect(buildMcodeLocalArgs({ model: 'minimax/MiniMax-M3#thinking' }))
            .toEqual(['--model', 'minimax/MiniMax-M3#thinking']);
    });

    it('drops a model id the CLI would reject instead of passing it on', () => {
        expect(buildMcodeLocalArgs({ model: 'not a model id' }))
            .toEqual([]);
        expect(buildMcodeLocalArgs({ model: 'gpt-5.4' }))
            .toEqual([]);
    });
});
