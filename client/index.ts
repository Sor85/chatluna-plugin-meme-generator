import type { Context } from 'cordis'
import { registerReactFormExtension } from '@chatluna/ui-schema-form/client'
import { WeightTable } from './weight-table'

export default function apply(ctx: Context) {
  ctx.effect(() => registerReactFormExtension({
    type: 'array',
    role: 'meme-generator:weights',
    component: WeightTable,
    priority: 30
  }))
}
