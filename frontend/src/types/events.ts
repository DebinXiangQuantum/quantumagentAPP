/**
 * events.ts —— SSE 事件契约（docs/ARCHITECTURE.md §7）。
 *
 * 说明：
 *  - 传输层为 EventSource；本文件只定义事件名与 data 载荷形状；
 *  - 会话流事件按 seq 单调递增，客户端 `?after=<eventId>` 断线续传；
 *  - 全局流（/api/v1/events）只有 task.updated / hardware.updated / error。
 */

export interface MessageDeltaData {
  conversation_id: string;
  message_id: string;
  delta: string;
  seq: number;
}

/** §7 v1.1：思考过程增量（先于正文 delta 到达；seq 与 delta 同源单调）。 */
export interface MessageReasoningData {
  conversation_id: string;
  message_id: string;
  delta: string;
  seq: number;
}

export interface MessageCompletedData {
  conversation_id: string;
  message_id: string;
  artifacts: import('./domain').Artifact[];
  /** v1.1：思考全文（可为空串；畸形缺省按 '' 降级） */
  reasoning?: string;
}

export interface TaskUpdatedData {
  task_id: string;
  status: import('./domain').TaskStatus;
  steps: import('./domain').Step[];
}

export interface HardwareUpdatedData {
  nodes: import('./domain').HardwareNode[];
}

export interface ErrorEventData {
  code: string;
  message: string;
}

/** 会话流事件（event name → data） */
export type ConversationStreamEvent =
  | { event: 'message.delta'; data: MessageDeltaData }
  | { event: 'message.reasoning'; data: MessageReasoningData }
  | { event: 'message.completed'; data: MessageCompletedData }
  | { event: 'error'; data: ErrorEventData };

/** 全局流事件 */
export type GlobalStreamEvent =
  | { event: 'task.updated'; data: TaskUpdatedData }
  | { event: 'hardware.updated'; data: HardwareUpdatedData }
  | { event: 'error'; data: ErrorEventData };

/** 连接状态（顶栏状态灯语义） */
export type StreamStatus = 'online' | 'connecting' | 'offline';

/** 流订阅句柄：close() 幂等 */
export interface StreamHandle {
  close: () => void;
}

export interface StreamCallbacks<E> {
  onEvent: (evt: E) => void;
  onStatus?: (status: StreamStatus) => void;
}
