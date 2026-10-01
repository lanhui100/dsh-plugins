import { RemoteCaller } from './lib/index.js'
import { getRemoteSessionDetail } from './src/session-detail.ts'

const baseUrl = process.env.REMOTE_SSH_BASE_URL ?? 'http://127.0.0.1:39387'
const caller = new RemoteCaller({ host: 'dev', baseUrl, requestTimeoutMs: 15_000 })

console.log('Testing getRemoteSessionDetail...')
const detail = await getRemoteSessionDetail(caller, 'session-9e712fed-efe3-47ee-abc6-410669daeba0')
console.log('Title:', detail.title)
console.log('asOfSeq:', detail.asOfSeq)
console.log('Stats:', detail.stats)
console.log('Goal:', detail.goal?.objective?.slice(0, 80))
console.log('Messages count:', detail.messages.length)
for (const m of detail.messages.slice(-3)) {
  console.log(`[${m.role}] ${m.text.slice(0, 80).replace(/\n/g, ' ')}${m.toolCalls ? ` (${m.toolCalls.length} tool calls)` : ''}`)
}
