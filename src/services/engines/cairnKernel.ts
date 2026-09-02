import { execa, type ResultPromise } from 'execa'
import { z } from 'zod/v4'

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { QueryParams } from '../../query.js'
import type { Terminal } from '../../query/transitions.js'
import { buildTool, type Tool, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'

type JsonRpcObj = Record<string, unknown>
type RpcResult = Record<string, string>

export type CairnTransport = {
  write: (obj: JsonRpcObj) => void
}

type Pending = {
  resolve: (result: RpcResult) => void
  reject: (err: Error) => void
}

export type PermissionHandler = (
  toolName: string,
  argsJson: string,
) => Promise<'allow' | 'deny'>

const READONLY_CAIRN_TOOLS = new Set([
  'file_read',
  'glob',
  'grep',
  'web_fetch',
  'todo',
  'memory',
])

export function resolveCairnKernelPath(): string {
  const configured = getGlobalConfig().cairnKernelPath
  if (configured) return configured
  const fromEnv = process.env.CAIRN_KERNEL_PATH
  if (fromEnv) return fromEnv
  return 'cairn-kernel'
}

export function extractLastUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'user' || message.isMeta) continue
    const content = message.message.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          !!block &&
          typeof block === 'object' &&
          block.type === 'text' &&
          typeof block.text === 'string',
      )
      .map(block => block.text)
      .join('')
  }
  return ''
}

export function createCairnTool(name: string): Tool {
  return buildTool({
    name,
    inputSchema: z.object({}).passthrough(),
    maxResultSizeChars: Infinity,
    isReadOnly: () => READONLY_CAIRN_TOOLS.has(name),
    async description() {
      return `cairn-kernel tool: ${name}`
    },
    async prompt() {
      return ''
    },
    async call() {
      return { data: '' }
    },
    mapToolResultToToolResultBlockParam(content, toolUseID) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: String(content),
      }
    },
    renderToolUseMessage() {
      return null
    },
    renderToolResultMessage() {
      return null
    },
  }) as unknown as Tool
}

export async function decideCairnPermission(
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  toolName: string,
  argsJson: string,
): Promise<'allow' | 'deny'> {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    input = { args: argsJson }
  }

  const decision = await canUseTool(
    createCairnTool(toolName),
    input,
    toolUseContext,
    createAssistantMessage({ content: '' }),
    `cairn_${toolName}`,
  )
  return decision.behavior === 'allow' ? 'allow' : 'deny'
}

export class CairnAcpClient {
  private pending = new Map<string, Pending>()
  private nextId = 0
  private lineBuf = ''
  onNotification?: (method: string, params: RpcResult) => void
  onPermissionRequest?: PermissionHandler

  constructor(private transport: CairnTransport) {}

  feed(chunk: string): void {
    this.lineBuf += chunk
    const lines = this.lineBuf.split('\n')
    this.lineBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) void this.handleLine(trimmed)
    }
  }

  async handleLine(trimmed: string): Promise<void> {
    let parsed: {
      id?: string
      method?: string
      params?: RpcResult
      result?: RpcResult
      error?: { message?: string }
    }
    try {
      parsed = JSON.parse(trimmed) as typeof parsed
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    if (
      parsed.id !== undefined &&
      parsed.method === undefined &&
      (parsed.result !== undefined || parsed.error !== undefined)
    ) {
      const pending = this.pending.get(String(parsed.id))
      if (!pending) return
      this.pending.delete(String(parsed.id))
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || 'JSON-RPC error'))
        return
      }
      pending.resolve(parsed.result || {})
      return
    }

    if (parsed.method === 'session/request_permission' && parsed.id !== undefined) {
      const toolName = parsed.params?.toolName ?? ''
      const argsJson = parsed.params?.args ?? '{}'
      const decision = this.onPermissionRequest
        ? await this.onPermissionRequest(toolName, argsJson)
        : 'deny'
      this.transport.write({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { decision },
      })
      return
    }

    if (parsed.method && parsed.id === undefined) {
      this.onNotification?.(parsed.method, parsed.params || {})
    }
  }

  request(method: string, params: RpcResult = {}): Promise<RpcResult> {
    const id = `c_${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: RpcResult = {}): void {
    this.transport.write({ jsonrpc: '2.0', method, params })
  }

  rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err)
    }
    this.pending.clear()
  }
}

type LiveSession = {
  client: CairnAcpClient
  kill: () => void
  sessionId: string
  model: string
  cwd: string
}

let live: LiveSession | null = null
let injectedClient: CairnAcpClient | undefined

export function setCairnKernelClientForTests(
  client: CairnAcpClient | undefined,
): void {
  injectedClient = client
}

export function resetCairnKernelClient(): void {
  live?.kill()
  live = null
  injectedClient = undefined
}

function spawnKernel(cwd: string): { client: CairnAcpClient; kill: () => void } {
  const subprocess: ResultPromise = execa(resolveCairnKernelPath(), [], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    buffer: false,
    reject: false,
    encoding: 'utf8',
  })

  const client = new CairnAcpClient({
    write(obj) {
      subprocess.stdin?.write(`${JSON.stringify(obj)}\n`)
    },
  })

  void (async () => {
    if (!subprocess.stdout) return
    for await (const chunk of subprocess.stdout) {
      client.feed(typeof chunk === 'string' ? chunk : String(chunk))
    }
  })()

  void subprocess.finally(() => {
    client.rejectAll(new Error('cairn-kernel process ended'))
    if (live?.client === client) live = null
  })

  return {
    client,
    kill() {
      subprocess.kill()
    },
  }
}

async function handshake(
  client: CairnAcpClient,
  cwd: string,
  model: string,
): Promise<{ sessionId: string }> {
  await client.request('initialize', { protocolVersion: '1' })
  await client.request('authenticate', {})
  const created = await client.request('session/new', { cwd, model })
  return { sessionId: created.sessionId ?? '' }
}

async function getSession(
  cwd: string,
  model: string,
): Promise<{ client: CairnAcpClient; sessionId: string }> {
  if (injectedClient) {
    return { client: injectedClient, sessionId: 'test-session' }
  }

  if (live && live.cwd === cwd) {
    if (live.model !== model) {
      await live.client.request('session/set_model', { model })
      live.model = model
    }
    return live
  }

  live?.kill()
  live = null
  const spawned = spawnKernel(cwd)
  const { sessionId } = await handshake(spawned.client, cwd, model)
  live = { ...spawned, sessionId, model, cwd }
  return live
}

export async function* runViaCairnKernel(
  params: QueryParams,
): AsyncGenerator<Message, Terminal> {
  const prompt = extractLastUserPrompt(params.messages)
  if (!prompt) {
    yield createAssistantAPIErrorMessage({
      content: 'cairn-kernel engine: no user prompt found in messages.',
    })
    return { reason: 'completed' }
  }

  const cwd = getCwd()
  const model =
    params.toolUseContext.options.mainLoopModel || getMainLoopModel()
  const abort = params.toolUseContext.abortController

  let client: CairnAcpClient
  let sessionId: string
  try {
    const session = await getSession(cwd, model)
    client = session.client
    sessionId = session.sessionId
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield createAssistantAPIErrorMessage({
      content: `Failed to start cairn-kernel: ${message}`,
    })
    return { reason: 'model_error', error: err }
  }

  client.onPermissionRequest = (toolName, argsJson) =>
    decideCairnPermission(
      params.canUseTool,
      params.toolUseContext,
      toolName,
      argsJson,
    )

  if (abort.signal.aborted) {
    yield createAssistantAPIErrorMessage({
      content: 'Operation cancelled by user.',
    })
    return { reason: 'aborted_streaming' }
  }

  const onAbort = () => {
    client.notify('session/cancel', { sessionId })
  }
  abort.signal.addEventListener('abort', onAbort, { once: true })

  try {
    const result = await client.request('session/prompt', { prompt })
    if (abort.signal.aborted) {
      yield createAssistantAPIErrorMessage({
        content: 'Operation cancelled by user.',
      })
      return { reason: 'aborted_streaming' }
    }
    yield createAssistantMessage({ content: result.text || '' })
    return { reason: 'completed' }
  } catch (err) {
    if (abort.signal.aborted) {
      yield createAssistantAPIErrorMessage({
        content: 'Operation cancelled by user.',
      })
      return { reason: 'aborted_streaming' }
    }
    const message = err instanceof Error ? err.message : String(err)
    yield createAssistantAPIErrorMessage({
      content: `cairn-kernel error: ${message}`,
    })
    return { reason: 'model_error', error: err }
  } finally {
    abort.signal.removeEventListener('abort', onAbort)
  }
}
