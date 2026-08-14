import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

export interface ActivatedPlugin {
  context: Context
  fiber: Fiber
  dispose(): Promise<void>
}

export async function activatePlugin<T>(plugin: Plugin<T>, config: T): Promise<ActivatedPlugin> {
  const root = new Context()
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true })
  await root.plugin(ToolRuntime)
  let context: Context | undefined
  await root.inject(['tools', 'systemPrompt'], (injected) => { context = injected })
  if (context === undefined) throw new Error('tool runtime injection did not activate')
  const fiber = context.plugin(plugin, config as never)
  await fiber
  return {
    context,
    fiber,
    dispose: () => root.fiber.dispose(),
  }
}

export async function withPlugin<T, R>(
  plugin: Plugin<T>,
  config: T,
  callback: (context: Context, fiber: Fiber) => Promise<R>,
): Promise<R> {
  const activated = await activatePlugin(plugin, config)
  try {
    return await callback(activated.context, activated.fiber)
  } finally {
    await activated.dispose()
  }
}

export function executeTool(context: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return context.tools.execute({
    callId: `test-${name}` as never,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}
