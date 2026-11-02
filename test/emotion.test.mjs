import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  affectNow, emotionLine, feel, setMood, resetEmotion, emotionStats, reappraise,
} from '../lib/emotion.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-emotion-'))
}

test('情绪引擎：被事撞到 → 心情变化 → 半衰 → 重置', () => {
  const dir = tempDir()
  try {
    assert.equal(affectNow(dir).key, 'normal')

    const good = feel(dir, { text: '谢谢你，有你真好', why: '他记得我' })
    assert.equal(good.ok, true)
    assert.ok(good.intensity > 0)
    assert.ok(['moved', 'soft', 'joy', 'happy'].includes(good.key))

    const bad = feel(dir, { text: '滚，闭嘴，烦死了', why: '被凶了' })
    assert.equal(bad.ok, true)
    assert.ok(bad.intensity > 0)

    const line = emotionLine(dir)
    assert.ok(line.includes('此刻'))
    assert.ok(line.includes('PAD') || line.includes('心里') || line.includes('同时在'))

    const s = emotionStats(dir)
    assert.ok(s.count24 >= 2)
    assert.ok(s.log.length >= 2)

    const now = Date.now()
    const m1 = affectNow(dir, now)
    const m2 = affectNow(dir, now + 10 * 3600 * 1000)
    assert.ok(m2.intensity <= m1.intensity + 1e-9)

    const angry = setMood(dir, 'angry', { why: '测试', intensity: 0.8 })
    assert.equal(angry.ok, true)
    assert.equal(affectNow(dir).key, 'angry')
    assert.ok(emotionLine(dir).includes('生气'))

    const n = reappraise(dir, { hours: 24 })
    assert.ok(n >= 1)

    resetEmotion(dir)
    assert.equal(affectNow(dir).key, 'normal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('插件：注册 5 个工具，并且只在该有情绪时注入提示', async () => {
  const dir = tempDir()
  try {
    const { apply } = await import('../index.js')
    const tools = new Map()
    let section = ''
    let onSession = null
    const ctx = {
      tools: { register(t) { tools.set(t.name, t); return () => {} } },
      on(ev, fn) { if (ev === 'agent/session-start') onSession = fn },
      logger: { info() {} },
    }
    apply(ctx, { dir })
    assert.equal(tools.size, 5)
    for (const name of ['emotion_status', 'emotion_feel', 'emotion_set', 'emotion_log', 'emotion_reappraise']) {
      assert.ok(tools.has(name), 'missing tool ' + name)
    }

    // 平常不注入
    onSession({ agent: { systemPrompt: { section: (s) => { section = s.text } } } })
    assert.equal(section, '')

    const r = await tools.get('emotion_feel').execute({ text: '谢谢你，有你真好', why: '测试' })
    assert.ok(r.report.includes('记下了'))

    onSession({ agent: { systemPrompt: { section: (s) => { section = s.text } } } })
    assert.ok(section.includes('独立情绪状态'))

    const st = await tools.get('emotion_status').execute({})
    assert.ok(st.report.includes('此刻'))
    assert.ok(st.report.includes('PAD'))

    const log = await tools.get('emotion_log').execute({ limit: 5 })
    assert.ok(log.report.includes('记下了') || log.report.length > 0)

    const set = await tools.get('emotion_set').execute({ key: 'shy', intensity: 0.5 })
    assert.ok(set.report.includes('害羞') || set.report.includes('此刻'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
