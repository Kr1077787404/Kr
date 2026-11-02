/**
 * dsh-emotion-standalone
 * ============================================================================
 * 独立情绪插件：把 dsh-memory-net 里的情绪引擎拆出来单独用。
 *
 * 不写记忆网、不改 persona.json、不依赖任何其它插件；只维护一份
 * <dir>/emotion.json（默认 $DSH_HOME/emotion-standalone/emotion.json）。
 *
 * 能力：
 *   - PAD 三维心情 + OCC/SEC 评价 + 多情绪混合 + 各自半衰期
 *   - 被一句话/一件事撞到时记一笔（emotion_feel）
 *   - 直接指定心情（emotion_set）、看此刻（emotion_status）、翻流水（emotion_log）
 *   - 新会话开始时，把当前心情塞进系统提示（只在非“平常”时注入，省 token）
 * ============================================================================
 */
import {
  defaultDir, affectNow, emotionLine, feel, setMood, emotionStats,
  reappraise, MOOD_PAD, EMOTIONS, moodLabelOf,
} from './lib/emotion.mjs'

export const name = 'dsh-emotion-standalone'
export const inject = ['tools']

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
}

function textTool(name, description, properties, run) {
  return {
    name,
    description,
    parameters: { type: 'object', properties },
    output: TOOL_OUTPUT,
    async execute(args) {
      try { return { report: await run(args || {}) } } catch (e) { return { report: '情绪插件出错：' + (e?.message || e) } }
    },
  }
}

function fmtMood(m) {
  return m.label + '（' + Math.round((Number(m.intensity) || 0) * 100) + '%｜' + (m.octant || '') + '）'
}

function statusReport(dir) {
  const m = affectNow(dir)
  const s = emotionStats(dir)
  const mix = (m.mix || []).slice(0, 4).map((x) => x.label + ' ' + Math.round((Number(x.e) || 0) * 100) + '%').join(' + ') || '无'
  const top = (s.top24 || []).map((x) => x.label + '×' + x.n).join('、') || '还没有'
  return [
    '此刻：' + fmtMood(m),
    'PAD：愉悦 ' + m.v + '｜唤醒 ' + m.a + '｜掌控 ' + m.d,
    '混合：' + mix,
    '为什么：' + (m.why || '—'),
    '最近 24 小时：' + s.count24 + ' 次；最多的是 ' + top,
  ].join('\n')
}

function logReport(dir, limit) {
  const s = emotionStats(dir)
  const rows = (s.log || []).slice(-Math.max(1, Math.min(50, limit))).reverse()
  if (!rows.length) return '还没有情绪记录。'
  return rows.map((e) => {
    const t = Number(e.at) ? new Date(Number(e.at)).toLocaleString('zh-CN', { hour12: false }) : '—'
    const why = e.why ? '｜' + e.why : ''
    return t + '  ' + (e.label || moodLabelOf(e.key)) + ' ' + Math.round((Number(e.intensity) || 0) * 100) + '%' + why
  }).join('\n')
}

export function apply(ctx, config = {}) {
  const dir = String(config.dir || process.env.DSH_EMOTION_DIR || defaultDir())
  const log = (...a) => { try { ctx.logger?.info?.('[emotion-standalone]', ...a) } catch { /* ignore */ } }
  log('data dir', dir)

  ctx.tools.register(textTool(
    'emotion_status',
    '看此刻的情绪状态：PAD 三维、多情绪混合、最近 24 小时分布。只读，不改变心情。',
    {},
    async () => statusReport(dir),
  ))

  ctx.tools.register(textTool(
    'emotion_feel',
    '被一句话/一件事撞到，记一笔情绪。text=对方说了什么/发生了什么；why=为什么会有这个感觉（会写进状态）。'
    + '强度按评价自动算；也可以给 intensity 直接压一个 0~1。',
    {
      text: { type: 'string', description: '撞到你的那句话/那件事（原话最好）' },
      why: { type: 'string', description: '为什么是这个感觉，一句话（会显示在状态里）' },
      cause: { type: 'string', description: '起因/场景（可选）' },
      intensity: { type: 'number', description: '直接指定强度 0~1（可选，不给就按评价算）' },
      silenceMin: { type: 'number', description: '对方多久没说话了（分钟，可选）' },
      energy: { type: 'number', description: '你此刻的电量 0~1（可选）' },
      src: { type: 'string', description: '来源标记（可选，比如 chat / note / event）' },
    },
    async (args) => {
      const text = String(args.text || '').trim()
      if (!text) return '给一句 text（对方说了什么 / 发生了什么）。'
      const r = feel(dir, {
        text,
        why: args.why,
        cause: args.cause,
        intensity: args.intensity,
        silenceMin: args.silenceMin,
        energy: args.energy,
        src: args.src || 'text',
      })
      if (!r || r.ok === false) return '没记成：' + (r?.error || '未知原因')
      if (r.skipped) return '太平常，没起波澜（强度不够，状态没变）。'
      return '记下了：' + r.emotion + '（' + Math.round((Number(r.intensity) || 0) * 100) + '%）\n' + emotionLine(dir)
    },
  ))

  ctx.tools.register(textTool(
    'emotion_set',
    '直接指定一种心情（不是被事撞出来的，是手动改）。一般只在测试/明确要求时用；'
    + 'key 取那 20 个心情之一，intensity 0~1。',
    {
      key: { type: 'string', description: 'normal/happy/joy/proud/asking/soft/moved/shy/calm/bored/tired/drained/sad/hurt/lonely/anxious/scared/angry/fierce/dejected' },
      why: { type: 'string', description: '为什么是这个心情（可选）' },
      intensity: { type: 'number', description: '强度 0~1，默认 0.6' },
    },
    async (args) => {
      const key = String(args.key || '').trim()
      if (!key) return '给一个 key。'
      if (!MOOD_PAD[key]) return '没有这个心情：' + key + '。可用：' + Object.keys(MOOD_PAD).join(' / ')
      const r = setMood(dir, key, {
        why: args.why || '手动指定',
        intensity: args.intensity == null ? 0.6 : args.intensity,
      })
      if (!r || r.ok === false) return '没改成：' + (r?.error || '未知原因')
      return '现在：' + emotionLine(dir)
    },
  ))

  ctx.tools.register(textTool(
    'emotion_log',
    '翻最近的情绪流水（默认 10 条，最多 50 条）。',
    {
      limit: { type: 'number', description: '看几条，默认 10，最多 50' },
    },
    async (args) => logReport(dir, Number(args.limit) || 10),
  ))

  ctx.tools.register(textTool(
    'emotion_reappraise',
    '认知重评：把最近一段时间的负性情绪强度压低一点（默认最近 24 小时）。',
    {
      hours: { type: 'number', description: '回看多少小时，默认 24' },
    },
    async (args) => {
      const n = reappraise(dir, { hours: Number(args.hours) || 24 })
      return n ? '重评了 ' + n + ' 条负性情绪，强度往下压了一点。\n' + emotionLine(dir) : '最近没有需要重评的负性情绪。'
    },
  ))

  // 新会话：只在真有情绪时注入，别让“平常”也占 token
  try {
    ctx.on?.('agent/session-start', (payload) => {
      try {
        const sp = payload?.agent?.systemPrompt
        if (!sp || typeof sp.section !== 'function') return
        const m = affectNow(dir)
        if ((m.key === 'normal' || m.intensity < 0.05) && !m.why) return
        const text = '【独立情绪状态】\n' + emotionLine(dir)
          + '\n（这是 dsh-emotion-standalone 维护的情绪；被事撞到可用 emotion_feel 记一笔，别把它当成人设。）'
        sp.section({ name: 'emotion-standalone', text })
      } catch (e) { log('session-start 注入失败（不影响工具）', e?.message) }
    })
  } catch (e) {
    log('hook 挂载失败（不影响工具）', e?.message)
  }
}

// 给测试/脚本用：把可用的心情 key 列出来
export const MOOD_KEYS = Object.keys(MOOD_PAD)
export const EMOTION_LABELS = EMOTIONS.map((e) => e.label)
