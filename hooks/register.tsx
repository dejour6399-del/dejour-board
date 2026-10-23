import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Todo, Usage } from '../types'

const PANE = 'dejour-board'
const STORE_KEY = 'todos'
const todos = atom({ plugin: 'dejour-board', key: 'todos' } as const, [], { shape: 'todos-1' })
const usage = atom({ plugin: 'dejour-board', key: 'usage' } as const, { limits: [] }, { shape: 'usage-1' })

const LIMIT_NAMES: Record<string, string> = { five_hour: '5시간 한도', seven_day: '주간 한도', spend_limit: '사용 한도' }

const resetText = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3)
  return ` · ${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} 초기화`
}

// 메모는 $.store 에도 적어 두어 다음 세션에서 다시 읽는다
async function saveTodos($: EngineInterface, fn: (list: Todo[]) => Todo[]) {
  const next = await update($, todos, list => fn(list ?? []))
  await $.store.set(STORE_KEY, next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(STORE_KEY)
    if (Array.isArray(saved)) await update($, todos, () => saved as Todo[])
    const now = await $.session.usage()
    await update($, usage, () => ({ contextPercent: now.context.percent, limits: now.rateLimits }))
    await $.command.register({ name: 'memo', description: '다음 할 일 메모 추가 (예: /memo 예정 일정 카드 설계)', argumentHint: '할 일' })
    await $.command.register({ name: 'board', description: '할 일 · 사용량 칸 열기' })
    void $.ui.open({ id: PANE, title: '할 일 · 사용량' })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => ({ contextPercent: e.context.percent, limits: e.rateLimits }))
    return next(e)
  })

  on('command.run', { command: 'memo' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: '메모할 내용을 같이 적어 주세요. 예) /memo 예정 일정 카드 설계' }
    await saveTodos($, list => [...list, { id: String(Date.now()), text, isDone: false }])
    await $.ui.open({ id: PANE, title: '할 일 · 사용량' })
    return { text: `할 일 추가: ${text}` }
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: '할 일 · 사용량' })
    return { text: '할 일 · 사용량 칸을 열었어요.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, todos)
    const now: Usage = await read($, usage)
    const open = list.filter(t => !t.isDone)
    const done = list.filter(t => t.isDone)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>📊 남은 사용량</Text>
          {now.limits.length === 0 && <Text dimColor>첫 응답 뒤에 표시돼요.</Text>}
          {now.limits.map(l => (
            <Text>
              {LIMIT_NAMES[l.kind] ?? l.kind}: {Math.round(100 - l.percentUsed)}% 남음{resetText(l.resetsAt)}
            </Text>
          ))}
          {now.contextPercent !== undefined && <Text dimColor>대화 기억 칸: {now.contextPercent}% 사용</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>📝 다음 할 일</Text>
          {open.length === 0 && <Text dimColor>할 일이 없어요. /memo 내용 으로 추가</Text>}
          {open.map(t => (
            <Button key={t.id} plain onPress={() => saveTodos($, l => l.map(x => (x.id === t.id ? { ...x, isDone: true } : x)))}>
              ☐ {t.text}
            </Button>
          ))}
          {done.slice(-5).map(t => (
            <Button key={`d${t.id}`} plain onPress={() => saveTodos($, l => l.filter(x => x.id !== t.id))}>
              <Text dimColor>☑ {t.text} (누르면 지움)</Text>
            </Button>
          ))}
          {e.surface !== 'mobile' && 'Input' in ui && (
            <ui.Input
              key="new"
              placeholder="할 일 입력 후 Enter"
              onSubmit={value => {
                const text = value.trim()
                if (text) void saveTodos($, l => [...l, { id: String(Date.now()), text, isDone: false }])
              }}
            />
          )}
        </Box>
      </Box>
    )
  })
}
