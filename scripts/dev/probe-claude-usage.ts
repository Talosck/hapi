#!/usr/bin/env bun
/**
 * Check where a Claude turn reports its usage.
 *
 * Claude's remote (SDK) path reports an all-zero usage block on every
 * assistant frame and carries the real numbers only on the turn's result
 * frame. The local (transcript) path has no result frame and reports the real
 * numbers on its assistant frames.
 *
 * This runs Claude the way HAPI does and prints the usage of both frames
 * side by side, so a change upstream is visible at a glance. With `--db` it
 * also scans a hub database and reports which sessions have assistant frames
 * without any usage.
 *
 * Usage:
 *   bun scripts/dev/probe-claude-usage.ts
 *   bun scripts/dev/probe-claude-usage.ts --model <model>
 *   bun scripts/dev/probe-claude-usage.ts --db ~/.hapi/hapi.db
 */
import { spawn } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

type Json = Record<string, unknown>

function argValue(name: string, fallback?: string): string | undefined {
    const directIndex = process.argv.indexOf(name)
    if (directIndex >= 0) return process.argv[directIndex + 1]
    const prefix = `${name}=`
    const direct = process.argv.find((arg) => arg.startsWith(prefix))
    return direct ? direct.slice(prefix.length) : fallback
}

function asRecord(value: unknown): Json | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
}

function readContent(raw: unknown): unknown {
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw)
        } catch {
            return null
        }
    }
    if (raw instanceof Uint8Array) {
        try {
            return JSON.parse(zstdDecompressSync(raw).toString('utf8'))
        } catch {
            return null
        }
    }
    return null
}

function runClaude(model: string | undefined, prompt: string): void {
    const claudePath = join(homedir(), '.local/bin/claude')
    const args = [
        '--output-format', 'stream-json',
        '--verbose',
        // HAPI drives Claude over stdin (--input-format stream-json) rather
        // than with --print. Both emit the same frames.
        '--input-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
    ]
    if (model) args.push('--model', model)

    const child = spawn(claudePath, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
    child.stdin.end()

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let message: Json
            try {
                message = JSON.parse(trimmed) as Json
            } catch {
                continue
            }
            if (message.type === 'assistant') {
                const assistant = asRecord(message.message)
                console.log('[assistant] model =', assistant?.model)
                console.log('             usage  =', JSON.stringify(assistant?.usage))
            } else if (message.type === 'result') {
                console.log('[result   ] usage  =', JSON.stringify(message.usage))
                console.log('             models =', JSON.stringify(message.modelUsage))
                child.kill()
                return
            }
        }
    })
}

function scanDatabase(dbPath: string): void {
    const db = new Database(dbPath, { readonly: true })
    const sessions = db
        .query("SELECT DISTINCT session_id FROM usage_events WHERE agent = 'claude'")
        .all() as Array<{ session_id: string }>

    for (const { session_id } of sessions) {
        const rows = db
            .query('SELECT content FROM messages WHERE session_id = ?')
            .all(session_id) as Array<{ content: unknown }>
        let zero = 0
        let measured = 0
        for (const row of rows) {
            const message = asRecord(readContent(row.content))
            const data = asRecord(asRecord(message?.content)?.data)
            if (data?.type !== 'assistant') continue
            const usage = asRecord(asRecord(data.message)?.usage)
            if (!usage) continue
            const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
            if (total === 0) zero += 1
            else measured += 1
        }
        const note = measured === 0 && zero > 0 ? '  <-- the frames carry no usage' : ''
        console.log(`${session_id.slice(0, 8)}  assistant frames without usage = ${String(zero).padStart(5)}, with usage = ${String(measured).padStart(5)}${note}`)
    }
    db.close()
}

const model = argValue('--model')
const prompt = argValue('--prompt', 'say hi')!
const dbPath = argValue('--db')

console.log('=== live probe ===')
runClaude(model, prompt)

if (dbPath) {
    console.log('\n=== hub history ===')
    scanDatabase(dbPath)
}
