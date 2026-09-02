import type { Command } from '../../commands.js'

const command = {
  name: 'engine',
  description: 'Switch the query engine (default or cairn-kernel)',
  argumentHint: '[default|cairn-kernel]',
  supportsNonInteractive: true,
  type: 'local',
  load: () => import('./engine.js'),
} satisfies Command

export default command
