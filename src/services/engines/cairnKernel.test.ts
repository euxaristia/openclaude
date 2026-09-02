import { afterEach, expect, test } from 'bun:test'

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { QueryParams } from '../../query.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import {
  CairnAcpClient,
  decideCairnPermission,
  extractLastUserPrompt,
  resetCairnKernelClient,
  runViaCairnKernel,
  setCairnKernelClientForTests,
} from './cairnKernel.js'

afterEach(() => {
  resetCairnKernelClient()
})

test('request/response correlation resolves the matching id', async () => {
  const sent: Record<string, unknown>[] = []
  const client = new CairnAcpClient({
    write(obj) {
      sent.push(obj)
    },
  })

  const pending = client.request('initialize', { protocolVersion: '1' })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.method).toBe('initialize')
  const id = String(sent[0]?.id)

  await client.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '1', agentName: 'cairn-kernel' },
    }),
  )

  await expect(pending).resolves.toEqual({
    protocolVersion: '1',
    agentName: 'cairn-kernel',
  })
})

test('permission request replies deny when handler denies', async () => {
  const sent: Record<string, unknown>[] = []
  const client = new CairnAcpClient({
    write(obj) {
      sent.push(obj)
    },
  })
  client.onPermissionRequest = async (toolName, argsJson) => {
    expect(toolName).toBe('shell')
    expect(argsJson).toContain('rm')
    return 'deny'
  }

  await client.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_1',
      method: 'session/request_permission',
      params: {
        sessionId: 'session_1',
        toolName: 'shell',
        args: JSON.stringify({ command: 'rm -rf /' }),
      },
    }),
  )

  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual({
    jsonrpc: '2.0',
    id: 'req_1',
    result: { decision: 'deny' },
  })
})

test('permission request defaults to deny without a handler', async () => {
  const sent: Record<string, unknown>[] = []
  const client = new CairnAcpClient({
    write(obj) {
      sent.push(obj)
    },
  })

  await client.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'req_2',
      method: 'session/request_permission',
      params: { toolName: 'file_edit', args: '{}' },
    }),
  )

  expect(sent[0]).toMatchObject({
    id: 'req_2',
    result: { decision: 'deny' },
  })
})

test('decideCairnPermission maps canUseTool deny to deny', async () => {
  const canUseTool: CanUseToolFn = async () => ({
    behavior: 'deny',
    message: 'nope',
    decisionReason: { type: 'hook', hookName: 'test' },
  })

  const decision = await decideCairnPermission(
    canUseTool,
    { options: { isNonInteractiveSession: true } } as ToolUseContext,
    'shell',
    JSON.stringify({ command: 'echo hi' }),
  )
  expect(decision).toBe('deny')
})

test('decideCairnPermission maps canUseTool allow to allow', async () => {
  const canUseTool: CanUseToolFn = async (tool, input) => {
    expect(tool.name).toBe('file_edit')
    expect(input).toEqual({ path: 'x.ts' })
    return { behavior: 'allow', updatedInput: input }
  }

  const decision = await decideCairnPermission(
    canUseTool,
    { options: { isNonInteractiveSession: true } } as ToolUseContext,
    'file_edit',
    JSON.stringify({ path: 'x.ts' }),
  )
  expect(decision).toBe('allow')
})

test('extractLastUserPrompt walks back past meta messages', () => {
  const messages = [
    createUserMessage({ content: 'old' }),
    createAssistantMessage({ content: 'ok' }),
    createUserMessage({ content: 'latest prompt' }),
    createUserMessage({ content: 'meta note', isMeta: true }),
  ]
  expect(extractLastUserPrompt(messages)).toBe('latest prompt')
})

test('runViaCairnKernel yields the prompt result and does not duplicate deltas', async () => {
  const sent: Record<string, unknown>[] = []
  const client = new CairnAcpClient({
    write(obj) {
      sent.push(obj)
      if (obj.method === 'session/prompt') {
        queueMicrotask(() => {
          void client.handleLine(
            JSON.stringify({
              jsonrpc: '2.0',
              id: obj.id,
              result: { sessionId: 'session_1', text: 'hello from cairn' },
            }),
          )
        })
      }
    },
  })
  setCairnKernelClientForTests(client)

  const canUseTool: CanUseToolFn = async () => ({
    behavior: 'deny',
    message: 'unused',
    decisionReason: { type: 'hook', hookName: 'test' },
  })

  const params = {
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool,
    toolUseContext: {
      abortController: new AbortController(),
      options: { mainLoopModel: 'deepseek-chat' },
    },
    querySource: 'sdk',
  } as QueryParams

  const yielded: Message[] = []
  const terminal = await collect(runViaCairnKernel(params), yielded)

  expect(sent.some(obj => obj.method === 'session/prompt')).toBe(true)
  expect(yielded).toHaveLength(1)
  expect(yielded[0]).toMatchObject({ type: 'assistant' })
  const content = yielded[0] && 'message' in yielded[0] ? yielded[0].message.content : []
  expect(content[0]).toMatchObject({ type: 'text', text: 'hello from cairn' })
  expect(terminal).toEqual({ reason: 'completed' })
})

async function collect<T, R>(
  gen: AsyncGenerator<T, R>,
  out: T[],
): Promise<R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
    out.push(next.value)
  }
}
