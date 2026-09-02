import type { LocalCommandCall } from '../../types/command.js'
import { resetCairnKernelClient } from '../../services/engines/cairnKernel.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

const ENGINES = ['default', 'cairn-kernel'] as const
type EngineName = (typeof ENGINES)[number]

function isEngineName(value: string): value is EngineName {
  return (ENGINES as readonly string[]).includes(value)
}

export const call: LocalCommandCall = async args => {
  const requested = args.trim().toLowerCase()
  const current = getGlobalConfig().engine ?? 'default'

  if (!requested) {
    return {
      type: 'text',
      value: `Current engine: ${current}. Use /engine default or /engine cairn-kernel.`,
    }
  }

  if (!isEngineName(requested)) {
    return {
      type: 'text',
      value: `Unknown engine '${requested}'. Valid engines: ${ENGINES.join(', ')}.`,
    }
  }

  saveGlobalConfig(config => ({
    ...config,
    engine: requested,
  }))

  if (requested !== 'cairn-kernel') {
    resetCairnKernelClient()
  }

  const extra =
    requested === 'cairn-kernel'
      ? ' Spawns the compiled cairn-kernel binary (cairnKernelPath, CAIRN_KERNEL_PATH, or PATH).'
      : ''

  return {
    type: 'text',
    value: `Engine set to ${requested}.${extra}`,
  }
}
