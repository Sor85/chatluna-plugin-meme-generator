import type { Context } from 'cordis'
import { registerReactFormExtension } from '@chatluna/ui-schema-form/client'
import { WeightTable } from './weight-table'
import { TemplateListField } from './template-field'

export default function apply(ctx: Context) {
  ctx.effect(() => registerReactFormExtension({
    type: 'array',
    role: 'meme-generator:weights',
    component: WeightTable,
    priority: 30
  }))
  ctx.effect(() => registerReactFormExtension({
    type: 'array',
    role: 'meme-generator:templates',
    component: TemplateListField,
    priority: 30
  }))
}
