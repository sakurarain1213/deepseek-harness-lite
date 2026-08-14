import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { LiteRuntime } from './runtime.js'

export interface RunResult {
  text: string
  completed: boolean
  reason?: { kind: string; message?: string }
}

function submittedTurn(events: readonly SessionEvent[], messageId: string): number | undefined {
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'user/message' && event.data.id === messageId) return turn
  }
  return undefined
}

function resultForTurn(events: readonly SessionEvent[], turn: number): RunResult {
  const turnEnd = events.find((event): event is Extract<SessionEvent, { type: 'turn/end' }> => (
    event.type === 'turn/end' && event.data.turn === turn
  ))
  if (turnEnd === undefined) return { text: '', completed: false }
  const messages = events
    .filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
    .filter(event => event.data.turn === turn)
  const finalMessage = [...messages].reverse().find(event => event.data.message.content.some(block => block.type === 'text'))
  const text = finalMessage?.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  const reason = turnEnd.data.reason
  return { text, completed: reason.kind === 'completed', reason }
}

export async function runTask(runtime: LiteRuntime, task: string): Promise<RunResult> {
  const prompt = task.trim()
  if (!prompt) throw new Error('task must be non-empty')
  const sessionId = SessionId(`lite-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const handle = await runtime.context.agents.create({
    sessionId,
    agentOptions: { provider: runtime.provider, model: runtime.model, maxTokens: 1024 },
  })
  try {
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    handle.agent.followup(message)
    await handle.agent.whenIdle()
    const events = [...handle.agent.session.events]
    runtime.lastEvents = events
    const turn = submittedTurn(events, message.id)
    return turn === undefined ? { text: '', completed: false } : resultForTurn(events, turn)
  } finally {
    await handle.dispose()
  }
}
