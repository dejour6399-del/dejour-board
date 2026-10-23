export type Todo = { id: string; text: string; isDone: boolean }
export type Usage = { contextPercent?: number; limits: { kind: string; percentUsed: number; resetsAt?: string }[] }

declare module 'claude-code' {
  interface PluginState {
    'dejour-board': { todos: Shaped<Todo[]>; usage: Shaped<Usage> }
  }
}
