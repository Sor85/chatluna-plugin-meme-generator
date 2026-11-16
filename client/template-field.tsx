import { useEffect, useRef, useState } from 'react'
import { FileImageIcon, ImageIcon, ImageOffIcon, ImagesIcon, ShapesIcon, TypeIcon } from 'lucide-react'
import { callAction, useLive } from '@chatluna/ui-client/client'
import { PickerListField, type SchemaRendererProps } from '@chatluna/ui-schema-form/client'
import type {} from '../src/webui'

const GROUPS = [
  { id: 'text-only', label: '纯文字', icon: <TypeIcon /> },
  { id: 'single-image-only', label: '单图', icon: <ImageIcon /> },
  { id: 'two-image-only', label: '双图', icon: <ImagesIcon /> },
  { id: 'image-and-text', label: '图文', icon: <FileImageIcon /> },
  { id: 'other', label: '其他', icon: <ShapesIcon /> }
]

// Previews outlive the picker so reopening it does not fetch them again; a failure is forgotten and retried next mount.
const previews = new Map<string, Promise<string>>()
const PARALLEL = 6
let running = 0
const waiting: (() => void)[] = []

function preview(key: string) {
  const cached = previews.get(key)
  if (cached) return cached
  const task = (async () => {
    if (running >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      return await callAction('meme-generator.preview', { key })
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  })()
  task.catch(() => previews.delete(key))
  previews.set(key, task)
  return task
}

/** Loads a template preview once it scrolls into view; the grid holds hundreds of templates. */
function Preview({ value }: { value: string }) {
  const placeholder = useRef<HTMLSpanElement>(null)
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = placeholder.current
    if (!element) return
    let alive = true
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      preview(value).then((url) => alive && setSrc(url), () => alive && setFailed(true))
    })
    observer.observe(element)
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [value])
  if (src) return <img src={src} alt="" className="object-contain" />
  if (failed) return <ImageOffIcon className="size-4 text-muted-foreground" />
  return <span ref={placeholder} className="block size-full rounded-sm bg-muted" />
}

/** `role('meme-generator:templates')`: template keys picked from a grid of their previews. */
export function TemplateListField(props: SchemaRendererProps) {
  const query = useLive('meme-generator.templates')
  const failed = query.data?.failed ?? 0
  return (
    <div className="min-w-0 text-sm leading-5" data-meme-template-field="">
      <PickerListField
        props={props}
        layout="grid"
        empty="未选择模板，模型需先通过 meme_search 查找模板。"
        source={{
          groups: GROUPS.map((group) => failed && group.id === 'other' ? { ...group, note: `${failed} 个模板信息读取失败，未列出` } : group),
          items: (query.data?.templates ?? []).map((template) => ({
            value: template.key,
            label: template.name,
            group: template.category,
            detail: template.detail,
            icon: <Preview value={template.key} />
          })),
          loading: query.status === 'loading',
          ...(query.error === undefined ? {} : { error: query.error }),
          placeholder: '搜索名称、key 或关键词…',
          empty: '暂无模板。'
        }}
      />
    </div>
  )
}
