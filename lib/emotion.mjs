/**
 * dsh-emotion-standalone / lib/emotion.mjs
 * ============================================================================
 * 独立情绪引擎：从 dsh-memory-net 的 lib/emotion.mjs 拆出来，去掉记忆网/人格/
 * 节点写入的耦合，只保留「评价 → 多情绪混合 → PAD 心情 → 半衰期 → 提示词」。
 *
 * 依据（和原版一致）：
 *   PAD 三维（Mehrabian & Russell, 1974）
 *   OCC 模型（Ortony, Clore & Collins, 1988）
 *   SEC 评价维度（Scherer, 1984/2001）
 *   情绪时长与消退（Verduyn et al., 2009/2012）
 *   心境一致性（Bower, 1981）
 *   认知重评（Gross, 1998）
 *
 * 数据只落在 <dir>/emotion.json；不写记忆网、不改 persona、不联网。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 默认数据目录：$DSH_EMOTION_DIR > $DSH_HOME/emotion-standalone > ~/.dsh/emotion-standalone */
export function defaultDir() {
  const env = String(process.env.DSH_EMOTION_DIR || '').trim()
  if (env) return env
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'emotion-standalone')
}

function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
}

export const EMOTION_VERSION = 1
/** 气质基线：略偏正、低唤醒、稍微有点掌控感（不是零，零就是没脾气） */
export const BASELINE = { v: 0.16, a: 0.26, d: 0.14 }
export const MOOD_HALF_LIFE_MIN = 240
export const EMOTION_HALF_LIFE_MIN = 40
export const FADE_OUT = 0.16
const MAX_LOG = 400

/** 那 20 个老 key 的 PAD 原型（近邻取名字；语气表认这些 key） */
export const MOOD_PAD = {
  normal: [0.10, 0.20, 0.10], happy: [0.60, 0.55, 0.30], joy: [0.75, 0.60, 0.35],
  proud: [0.55, 0.45, 0.65], asking: [0.10, 0.10, -0.45], soft: [0.45, -0.15, 0.05],
  moved: [0.55, 0.35, -0.10], shy: [0.35, 0.40, -0.35], calm: [0.20, -0.45, 0.15],
  bored: [-0.20, -0.45, -0.05], tired: [-0.25, -0.50, -0.20], drained: [-0.45, -0.35, -0.45],
  sad: [-0.60, -0.30, -0.35], hurt: [-0.50, 0.15, -0.40], lonely: [-0.55, -0.20, -0.45],
  anxious: [-0.45, 0.60, -0.55], scared: [-0.60, 0.75, -0.65], angry: [-0.55, 0.65, 0.45],
  fierce: [-0.40, 0.80, 0.55], dejected: [-0.80, -0.35, -0.70],
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, Number(x) || 0))
const lerp = (a, b, t) => a + (b - a) * clamp(t)
const round3 = (x) => Math.round(Number(x) * 1000) / 1000

/** PAD 八分区（Mehrabian 那八个名字，翻成人话） */
export function octantOf(pad = {}) {
  const s = (x) => (Number(x) >= 0 ? '+' : '-')
  const map = {
    '+++': '兴奋（exuberant）', '++-': '依赖（dependent）', '+-+': '放松（relaxed）', '+--': '温顺（docile）',
    '-++': '敌意（hostile）', '-+-': '焦虑（anxious）', '--+': '轻蔑（disdainful）', '---': '无聊（bored）',
  }
  return map[s(pad.v) + s(pad.a) + s(pad.d)] || '平常'
}

/**
 * 情绪表：key = 老的那 20 个名字之一（给语气表用）；label = 更细的名字；
 * pad 是这套情绪落在哪；half 是它自己的半衰期（分钟）；when 是 OCC+SEC 的判据。
 * 顺序 = 特异性从高到低，先撞上的就是它。
 */
export const EMOTIONS = [
  { k: 'fierce', label: '炸毛护人', p: [-0.40, 0.80, 0.55], half: 25,
    when: (a) => a.agency === 'other' && a.normFit <= -0.55 && a.care >= 0.5 && a.conduciveness <= -0.25 },
  { k: 'angry', label: '生气', p: [-0.55, 0.65, 0.45], half: 35,
    when: (a) => a.agency === 'other' && a.normFit <= -0.3 && a.conduciveness <= -0.3 && a.control >= 0.35 },
  { k: 'hurt', label: '委屈', p: [-0.50, 0.15, -0.40], half: 90,
    when: (a) => a.agency === 'other' && a.conduciveness <= -0.3 && a.normFit <= -0.05 && a.urgency >= 0.3 },
  { k: 'lonely', label: '孤独', p: [-0.55, -0.20, -0.45], half: 150,
    when: (a) => a.care >= 0.4 && a.conduciveness <= -0.1 && a.certainty >= 0.4 && a.urgency <= 0.4 },
  { k: 'hurt', label: '吃味', p: [-0.42, 0.42, -0.32], half: 40,
    when: (a) => a.agency === 'other' && a.care >= 0.4 && a.conduciveness <= -0.2 && a.novelty >= 0.2 },
  { k: 'moved', label: '感动', p: [0.55, 0.35, -0.10], half: 70,
    when: (a) => a.care >= 0.5 && a.conduciveness >= 0.2 && a.relevance >= 0.5 },
  { k: 'soft', label: '心软', p: [0.45, -0.15, 0.05], half: 80,
    when: (a) => a.care >= 0.4 && a.conduciveness <= 0.2 },
  { k: 'joy', label: '高兴', p: [0.75, 0.60, 0.35], half: 45,
    when: (a) => a.conduciveness >= 0.3 && a.certainty >= 0.4 },
  { k: 'happy', label: '轻快', p: [0.60, 0.55, 0.30], half: 60,
    when: (a) => a.conduciveness >= 0.2 && a.urgency >= 0.3 },
  { k: 'joy', label: '松了一口气', p: [0.48, -0.10, 0.20], half: 50,
    when: (a) => a.conduciveness >= 0.2 && a.expectation <= -0.2 },
  { k: 'calm', label: '满足', p: [0.40, -0.30, 0.30], half: 100,
    when: (a) => a.conduciveness >= 0.2 && a.urgency <= 0.25 },
  { k: 'proud', label: '得意', p: [0.55, 0.45, 0.65], half: 40,
    when: (a) => a.agency === 'self' && a.conduciveness >= 0.3 && a.normFit >= 0.1 },
  { k: 'shy', label: '害臊', p: [0.35, 0.40, -0.35], half: 35,
    when: (a) => a.agency === 'other' && a.conduciveness >= 0.2 && a.normFit <= 0 && a.relevance >= 0.5 },
  // 被调戏：尴尬里带一点不讨厌 —— 第一次是羞，不是气
  { k: 'shy', label: '害臊', p: [0.35, 0.40, -0.35], half: 35,
    when: (a) => a.agency === 'other' && a.normFit <= -0.15 && a.conduciveness >= 0 && a.relevance >= 0.4 },
  // 一再被越界：这回不是羞了，是真恼
  { k: 'angry', label: '生气', p: [-0.55, 0.65, 0.45], half: 35,
    when: (a) => a.agency === 'other' && a.normFit <= -0.45 && a.urgency >= 0.3 },
  { k: 'happy', label: '意外之喜', p: [0.65, 0.70, 0.25], half: 25,
    when: (a) => a.novelty >= 0.7 && a.conduciveness >= 0.2 },
  { k: 'anxious', label: '悬着', p: [-0.45, 0.60, -0.55], half: 60,
    when: (a) => a.conduciveness <= -0.2 && a.certainty <= 0.45 && a.urgency >= 0.4 },
  { k: 'scared', label: '怕', p: [-0.60, 0.75, -0.65], half: 30,
    when: (a) => a.conduciveness <= -0.35 && a.control <= 0.5 && a.urgency >= 0.6 },
  { k: 'dejected', label: '提不起劲', p: [-0.65, -0.35, -0.60], half: 160,
    when: (a) => a.conduciveness <= -0.5 && a.control <= 0.25 && a.certainty >= 0.5 },
  { k: 'sad', label: '难过', p: [-0.60, -0.30, -0.35], half: 120,
    when: (a) => a.conduciveness <= -0.3 },
  { k: 'sad', label: '失望', p: [-0.50, -0.20, -0.30], half: 90,
    when: (a) => a.conduciveness <= -0.2 && a.expectation >= 0.2 },
  { k: 'angry', label: '看不上', p: [-0.45, 0.30, 0.50], half: 60,
    when: (a) => a.agency === 'other' && a.normFit <= -0.4 && a.control >= 0.5 },
  { k: 'tired', label: '累', p: [-0.25, -0.50, -0.20], half: 120,
    when: (a) => a.energy <= 0.3 },
  { k: 'bored', label: '无聊', p: [-0.20, -0.45, -0.05], half: 90,
    when: (a) => a.relevance <= 0.2 },
  { k: 'calm', label: '平静', p: [0.20, -0.45, 0.15], half: 120,
    when: (a) => a.relevance <= 0.4 },
]

/** 没有专门规则时的落点：顺意就轻快，不顺意就闷，都说不上就平常 */
function fallbackEmotion(a) {
  if (a.conduciveness >= 0.3) return { k: 'happy', label: '有点高兴', p: [0.55, 0.40, 0.20], half: 50 }
  if (a.conduciveness <= -0.3) return { k: 'sad', label: '有点闷', p: [-0.45, -0.15, -0.25], half: 90 }
  return { k: 'normal', label: '平常', p: [BASELINE.v, BASELINE.a, BASELINE.d], half: 60 }
}

/** 评价值 → 一条情绪：{ key, label, pad, intensity, half } */
export function emotionFromAppraisal(raw = {}) {
  const a = {
    novelty: clamp(raw.novelty), relevance: clamp(raw.relevance, 0, 1),
    conduciveness: clamp(raw.conduciveness, -1, 1), expectation: clamp(raw.expectation, -1, 1),
    certainty: clamp(raw.certainty, 0, 1), control: clamp(raw.control, 0, 1),
    normFit: clamp(raw.normFit, -1, 1), urgency: clamp(raw.urgency, 0, 1),
    care: clamp(raw.care, 0, 1), energy: raw.energy == null ? 0.6 : clamp(raw.energy, 0, 1),
    agency: ['self', 'other', 'circumstance'].includes(raw.agency) ? raw.agency : 'circumstance',
  }
  if (a.relevance < 0.15 && a.novelty < 0.3) return { key: 'normal', label: '平常', pad: { ...BASELINE }, intensity: 0, half: 60, appr: a }
  let hit = null
  for (const e of EMOTIONS) { if (e.when(a)) { hit = e; break } }
  if (!hit) hit = fallbackEmotion(a)
  // 强度 = 相关性 × 偏离预期 × 确定性（Verduyn 那套的简化），再按情绪自身的唤醒度加权
  const dev = Math.abs(a.expectation) * 0.5 + Math.abs(a.conduciveness) * 0.5
  let intensity = 0.22 + 0.46 * a.relevance + 0.34 * dev + 0.18 * a.novelty + 0.12 * a.urgency + 0.10 * a.certainty
  if (hit.k === 'normal') intensity *= 0.35
  intensity = clamp(intensity, 0, 1)
  const [v, ar, d] = hit.p
  return { key: hit.k, label: hit.label, pad: { v: v * intensity + BASELINE.v * (1 - intensity), a: clamp(ar * intensity + BASELINE.a * (1 - intensity), 0, 1), d: d * intensity + BASELINE.d * (1 - intensity) }, intensity: round3(intensity), half: hit.half, appr: a }
}

/** PAD → 最近的那个老 key（给语气表用） */
export function moodKeyOfPad(pad = {}) {
  let best = 'normal', bd = Infinity
  for (const [k, [v, a, d]] of Object.entries(MOOD_PAD)) {
    const dv = (Number(pad.v) || 0) - v, da = (Number(pad.a) || 0) - a, dd = (Number(pad.d) || 0) - d
    const dist = dv * dv * 1.0 + da * da * 0.8 + dd * dd * 0.5
    if (dist < bd) { bd = dist; best = k }
  }
  return best
}
const MOOD_LABEL = { normal: '平常', happy: '心情好', joy: '喜悦', proud: '得意', asking: '有求于人', soft: '难得温柔', moved: '感动', shy: '害羞', calm: '平静', bored: '无聊', tired: '困/累', drained: '心累', sad: '难过', hurt: '委屈', lonely: '孤独', anxious: '焦虑', scared: '害怕', angry: '生气', fierce: '炸毛护人', dejected: '绝望' }
export function moodLabelOf(key) { return MOOD_LABEL[String(key || 'normal')] || String(key || '平常') }
/* ───────────────────────── ① 评价（SEC）：一句话 → 评价值 ───────────────────────── */
const BASE_APPR = { novelty: 0.2, relevance: 0.45, conduciveness: 0, expectation: 0, certainty: 0.5, control: 0.45, normFit: 0, urgency: 0.3, care: 0, energy: 0.6, agency: 'other' }

const APPRAISAL_RULES = [
  { re: /(骂|黑|说|讲).{0,6}(我|你|他|她).{0,6}(坏话|不是|不行|废物|垃圾)|欺负(我|你|他|她)/,
    p: { agency: 'other', normFit: -0.7, care: 0.85, conduciveness: -0.5, relevance: 0.95, urgency: 0.85 } },
  { re: /(谢谢你|辛苦你|有你真好|只有你|离不开你|想你了|我信你)/,
    p: { agency: 'other', conduciveness: 0.6, care: 0.6, relevance: 0.85, urgency: 0.5 } },
  { re: /(对不起|抱歉|我错了|别生气|原谅我)/,
    p: { conduciveness: 0.35, expectation: -0.3, relevance: 0.7, urgency: 0.5 } },
  { re: /(难受|不舒服|头疼|失眠|睡不着|压力大|好累|撑不住|emo|郁闷|心里堵|被骂了|委屈)/,
    p: { care: 0.9, conduciveness: -0.35, relevance: 0.85, urgency: 0.6, agency: 'circumstance' } },
  { re: /(滚|闭嘴|烦死|蠢|笨死|废物|没用的东西|别烦我|你懂什么|少废话)/,
    p: { agency: 'other', conduciveness: -0.55, normFit: -0.3, relevance: 0.9, urgency: 0.75, control: 0.35 } },
  { re: /(帮我|求你|拜托|帮个忙|你能不能|麻烦你|靠你了)/,
    p: { control: 0.2, relevance: 0.7, urgency: 0.6, conduciveness: 0.05 } },
  { re: /(可爱|乖|聪明|厉害|好听|好看|喜欢你|真棒|牛啊|绝了)/,
    p: { agency: 'other', conduciveness: 0.55, normFit: -0.15, relevance: 0.7, urgency: 0.55 } },
  // 被调戏/撩：说不上多大事，但边界被蹭了一下 —— 先羞，攒多了就恼（grv 会把它越推越负）
  { re: /(调戏|撩|摸摸|摸一摸|亲一口|让我抱|小美人|小可爱过来|勾引|色色的|想摸)/,
    p: { agency: 'other', conduciveness: 0.25, normFit: -0.2, relevance: 0.6, urgency: 0.45, care: 0.2, novelty: 0.4 } },
  { re: /(爱你|亲亲|抱抱|宝贝|想你)/,
    p: { agency: 'other', conduciveness: 0.5, care: 0.5, relevance: 0.75, urgency: 0.55 } },
  { re: /(算了|随便你|无所谓|不想说|没意思|失望)/,
    p: { conduciveness: -0.45, relevance: 0.6, urgency: 0.25, control: 0.3 } },
  { re: /(成了|成功了|搞定了|通过了|到了|赢了|做完了)/,
    p: { conduciveness: 0.6, certainty: 0.75, relevance: 0.6, expectation: 0.3 } },
  { re: /(没成|失败了|挂了|黄了|被拒|搞砸|坏了)/,
    p: { conduciveness: -0.6, certainty: 0.75, relevance: 0.6, expectation: 0.2 } },
  { re: /(哈哈|笑死|好玩|乐死|绷不住|离谱)/,
    p: { conduciveness: 0.4, relevance: 0.4, urgency: 0.5, energy: 0.75 } },
  { re: /(在吗|晚安|早安|吃了没|想聊|出来聊|睡了没)/,
    p: { conduciveness: 0.25, relevance: 0.42, urgency: 0.3 } },
  { re: /(笨|傻|蠢|垃圾|废物|烦人)/,
    p: { agency: 'other', conduciveness: -0.4, normFit: -0.25, relevance: 0.7, urgency: 0.5 } },
  { re: /(困|熬夜|累死|没睡|好累)/,
    p: { energy: 0.15, relevance: 0.3, conduciveness: -0.15, agency: 'circumstance' } },
  { re: /(居然|没想到|第一次|竟然|突然|吓死|惊了)/,
    p: { novelty: 0.75, relevance: 0.55, urgency: 0.55 } },
  // 下面这几条是把"人话"直接翻成评价值：怕、气、开心、难过、孤单
  { re: /(怕|好怕|害怕|恐怖|吓人|不敢|慌了|发抖|你别过来)/,
    p: { agency: 'other', conduciveness: -0.6, control: 0.2, urgency: 0.7, relevance: 0.7, novelty: 0.3, _low: ['control'] } },
  { re: /(生气|气死|火大|来气|受不了|凭什么|你再说|别碰我)/,
    p: { agency: 'other', conduciveness: -0.5, normFit: -0.35, urgency: 0.65, control: 0.55, relevance: 0.7 } },
  { re: /(开心|高兴|太好了|舒服|爽|快乐|幸福|乐开花)/,
    p: { conduciveness: 0.65, relevance: 0.65, urgency: 0.55, energy: 0.8, certainty: 0.6 } },
  { re: /(难过|伤心|想哭|失落|低落|心里堵)/,
    p: { conduciveness: -0.6, relevance: 0.65, urgency: 0.45, control: 0.35 } },
  { re: /(委屈|冤枉|凭什么这么说|没人管我)/,
    p: { agency: 'other', conduciveness: -0.55, normFit: -0.25, urgency: 0.5, relevance: 0.65 } },
  { re: /(一个人|没人理|孤单|寂寞|没人说话|都在忙)/,
    p: { agency: 'circumstance', care: 0.45, conduciveness: -0.35, relevance: 0.6, certainty: 0.6, urgency: 0.25 } },
]

/** 数值字段：谁更"重"听谁的（别让最后一条小规则把大情绪盖掉） */
function mergeAppr(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'agency') { out.agency = v; continue }
    if (k === '_low') { out._low = Array.from(new Set([...(out._low || []), ...(Array.isArray(v) ? v : [])])); continue }
    const nv = Number(v)
    if (!Number.isFinite(nv)) continue
    const cur = Number(out[k]) || 0
    if (['conduciveness', 'normFit', 'expectation'].includes(k)) out[k] = Math.abs(nv) > Math.abs(cur) ? nv : cur
    else out[k] = Math.max(cur, nv)
  }
  return out
}

/**
 * 一句话 → 评价值（Scherer 那四组：相关性 / 含义 / 应对 / 规范）。
 * silenceMin：他多久没说话了（20 分钟以上又没话，就偏"孤独"那头）；energy：身体的电量。
 */
export function appraiseText(text, { silenceMin = 0, energy = null, fromSelf = false } = {}) {
  const t = String(text || '')
  let a = { ...BASE_APPR }
  if (fromSelf) a.agency = 'self'
  for (const r of APPRAISAL_RULES) {
    if (!r.re.test(t)) continue
    a = mergeAppr(a, r.p)
  }
  if (Array.isArray(a._low)) { for (const k of a._low) a[k] = Math.min(Number(a[k]) || 0, 0.4); delete a._low }
  if (energy != null) a.energy = clamp(energy)
  if (Number(silenceMin) >= 20 && t.trim().length <= 24) {
    a = mergeAppr(a, { care: 0.5, conduciveness: -0.3, relevance: 0.6, certainty: 0.55, urgency: 0.35, agency: 'circumstance' })
  }
  if (!t.trim()) { a.relevance = Math.min(a.relevance, 0.35); a.conduciveness = Math.min(0, a.conduciveness) }
  return a
}

/** 一轮视频/一堆标题 → 评价值（刷完一轮也会改心情） */
const MEDIA_RULES = [
  { re: /(搞笑|沙雕|笑死|段子|整活|抽象|憋笑|离谱)/, p: { conduciveness: 0.45, relevance: 0.55, energy: 0.75, urgency: 0.45 } },
  { re: /(猫|狗|橘猫|小狗|萌|可爱|小孩|宝宝|毛孩子)/, p: { care: 0.6, conduciveness: 0.3, relevance: 0.55 } },
  { re: /(励志|坚持|努力|逆袭|奋斗|梦想|感人|泪目|破防|母亲|父亲|离别|重逢|治愈)/, p: { care: 0.6, conduciveness: 0.3, relevance: 0.7, urgency: 0.4 } },
  { re: /(气人|离谱|过分|缺德|欺负|渣|恶心|看吐)/, p: { agency: 'other', conduciveness: -0.5, normFit: -0.45, relevance: 0.7, urgency: 0.6 } },
  { re: /(恐怖|惊悚|鬼|灵异|吓死|细思极恐)/, p: { conduciveness: -0.5, control: 0.2, urgency: 0.8, relevance: 0.6 } },
  { re: /(想哭|鼻酸|戳心|心里难受|一个人住|分手|遗憾|错过)/, p: { conduciveness: -0.35, care: 0.45, relevance: 0.6 } },
  { re: /(风景|旅行|海|日落|山|美食|做饭|治愈系)/, p: { conduciveness: 0.25, relevance: 0.4, urgency: 0.15 } },
  { re: /(丧|躺平|内耗|孤独|抑郁|没意义|看不到头)/, p: { conduciveness: -0.5, control: 0.25, certainty: 0.6, relevance: 0.55 } },
  { re: /(无聊|水|重复|带货|广告|又是这个|老套)/, p: { relevance: 0.15, conduciveness: -0.1, energy: 0.45 } },
]

export function appraiseMedia(items, { energy = null } = {}) {
  const list = Array.isArray(items) ? items : (items ? [items] : [])
  const texts = list.map((x) => {
    if (x == null) return ''
    if (typeof x === 'string') return x
    return [x.title, x.desc, x.text, x.author, x.gist, x.evidence, Array.isArray(x.tags) ? x.tags.join(' ') : '', Array.isArray(x.comments) ? x.comments.join(' ') : '']
      .filter(Boolean).join(' ')
  }).filter(Boolean)
  if (!texts.length) return null
  let a = { ...BASE_APPR, relevance: 0.4, urgency: 0.35 }
  let hits = 0
  for (const t of texts) {
    for (const r of MEDIA_RULES) {
      if (!r.re.test(t)) continue
      a = mergeAppr(a, r.p)
      hits++
    }
  }
  if (!hits) return null
  a.energy = energy == null ? a.energy : clamp(energy)
  return a
}
/* ───────────────────────── ② 落盘：emotion.json ───────────────────────── */
export function emoFile(dir = defaultDir()) { return join(dir, 'emotion.json') }

function blankState() {
  return { version: EMOTION_VERSION, at: 0, mood: { v: BASELINE.v, a: BASELINE.a, d: BASELINE.d, intensity: 0, label: '平常', key: 'normal', why: '', at: 0, half: EMOTION_HALF_LIFE_MIN }, log: [] }
}

export function loadEmotion(dir = defaultDir()) {
  try {
    const p = emoFile(dir)
    if (!existsSync(p)) return blankState()
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const b = blankState()
    return { ...b, ...j, mood: { ...b.mood, ...(j.mood || {}) }, log: Array.isArray(j.log) ? j.log : [] }
  } catch { return blankState() }
}

export function saveEmotion(dir = defaultDir(), st = null) {
  ensureDir(dir)
  const p = emoFile(dir)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(st, null, 1))
  renameSync(tmp, p)
  return st
}

/** 心情按半衰期回落到气质基线（Moeller 那类指数衰减的最简形式） */
export function decayMood(mood = {}, now = Date.now()) {
  const at = Number(mood.at) || now
  const ageMin = Math.max(0, (now - at) / 60000)
  const k = Math.pow(0.5, ageMin / MOOD_HALF_LIFE_MIN)
  const ki = Math.pow(0.5, ageMin / Math.max(10, Number(mood.half) || EMOTION_HALF_LIFE_MIN))
  const v = BASELINE.v + ((Number(mood.v) || 0) - BASELINE.v) * k
  const a = clamp(BASELINE.a + ((Number(mood.a) || 0) - BASELINE.a) * k, 0, 1)
  const d = BASELINE.d + ((Number(mood.d) || 0) - BASELINE.d) * k
  const intensity = round3(clamp((Number(mood.intensity) || 0) * ki, 0, 1))
  const faded = intensity < FADE_OUT
  const key = faded ? 'normal' : String(mood.key || moodKeyOfPad({ v, a, d }))
  return { v: round3(v), a: round3(a), d: round3(d), intensity, key, label: faded ? '平常' : String(mood.label || moodLabelOf(key)), why: faded ? '' : String(mood.why || ''), at: now, half: Number(mood.half) || EMOTION_HALF_LIFE_MIN }
}

function emoBucket(v, a) {
  if (v >= 0.3) return 'warm'
  if (v <= -0.35) return a >= 0.4 ? 'hurt' : 'deep'
  return a <= -0.3 ? 'boring' : 'neutral'
}

/** 一次情绪 → 混进心情（心情是慢积分，不会被一句话整个翻过去） */
function applyEpisode(st, ep, why, now) {
  const prev = decayMood(st.mood, now)
  const w = clamp(0.30 + 0.5 * ep.intensity, 0.30, 0.85)
  const mood = {
    v: round3(lerp(prev.v, ep.pad.v, w)),
    a: round3(clamp(lerp(prev.a, ep.pad.a, w), 0, 1)),
    d: round3(lerp(prev.d, ep.pad.d, w)),
    intensity: round3(clamp(prev.intensity * (1 - w) + ep.intensity * w, 0, 1)),
    half: Number(ep.half) || EMOTION_HALF_LIFE_MIN,
    at: now,
  }
  mood.key = ep.intensity >= 0.3 ? ep.key : moodKeyOfPad(mood)
  mood.label = ep.intensity >= 0.3 ? ep.label : moodLabelOf(mood.key)
  mood.why = String(why || '').slice(0, 80)
  st.mood = mood
  st.at = now
  return mood
}

/* ───────────────────────── ③ 对外：撞一下、读一下 ───────────────────────── */

/**
 * feel —— 被一件事撞了一下。
 * opts: { text | appr | key, why, cause, src, intensity, silenceMin, energy, remember, mirror, now }
 * 返回 { ok, emotion, key, pad, intensity, mood, node }
 */
export function feel(dir = defaultDir(), opts = {}) {
  try {
    const now = Number(opts.now) || Date.now()
    let st = loadEmotion(dir)
    const key = opts.key ? String(opts.key) : ''
    let list = []
    let topI = 0
    let apprUsed = opts.appr || null
    if (key) {
      // 指定了心情（手动改）也走多情绪：它自己占主，评价值带出来的别的情绪作陪衬
      const appr = opts.appr || (opts.text ? appraiseText(opts.text, { silenceMin: opts.silenceMin, energy: opts.energy }) : null)
      const e2 = appr ? emotionFromAppraisal(appr) : null
      const inten = opts.intensity == null ? (e2 ? e2.intensity : 0.5) : clamp(opts.intensity)
      const k0 = MOOD_PAD[key] ? key : moodKeyOf(key)
      list = [{ key: k0, label: opts.label ? String(opts.label) : moodLabelOf(k0), I: inten, half: e2 ? e2.half : keyHalf(k0) }]
      if (appr) {
        for (const x of emotionMixFromAppraisal(appr).list) {
          if (x.I >= 0.18 && x.key !== k0) list.push({ ...x, I: round3(x.I * 0.6) })
        }
      }
      topI = inten
    } else {
      const appr = opts.appr || appraiseText(opts.text || '', { silenceMin: opts.silenceMin, energy: opts.energy })
      // ⭐ 旧账：同一类冒犯反复来，气会攒起来（Habituation 的反面，sensitization）。
      // 攒着的时候，同一句话听着更冲 —— 所以不是"每次都一样生气"，是越攒越压不住。
      const nf0 = Number(appr.normFit) || 0
      const g0 = st.grv && Number.isFinite(Number(st.grv.e)) ? st.grv : { e: 0, at: now, half: 180 }
      const gHalf = Math.max(10, Number(g0.half) || 180)
      const gDecay = Math.pow(0.5, Math.max(0, (now - Number(g0.at || now)) / 60000) / gHalf)
      /**
       * ⭐ 2026-10-31：没被冒犯时的"排气"原来写死 `-0.03`，而且是**每次调用扣一次** ——
       *   聊得密（30 秒一句）就一分钟排两回、火十分钟就没了；半天不说话反倒一点不排。
       *   改成按分钟扣：一分钟一次时跟原来完全一样，30 秒一次只扣一半，最多按 3 分钟算。
       */
      const gDtMin = Math.max(0, (now - Number(g0.at || now)) / 60000)
      const gDrain = 0.03 * clamp(gDtMin, 0.25, 3)
      const grv = clamp(Number(g0.e) * gDecay + (nf0 < -0.1 ? Math.abs(nf0) * 0.45 : -gDrain), 0, 1)
      st.grv = { e: round3(grv), at: now, half: gHalf }
      const aUse = { ...appr }
      if (grv >= 0.05 && (nf0 <= 0 || Number(appr.conduciveness) < 0)) {
        aUse.normFit = clamp((Number(appr.normFit) || 0) - 0.55 * grv, -1, 1)
        aUse.conduciveness = clamp((Number(appr.conduciveness) || 0) - 0.35 * grv, -1, 1)
      }
      apprUsed = aUse
      const mixr = emotionMixFromAppraisal(aUse)
      list = mixr.list.slice()
      // 只有"这次真被点着"的情绪才加火；没被点着的别硬塞（不然没生气也会凭空冒出火）
      if (grv >= 0.08) {
        for (const x of list) {
          if (!x.on) continue
          if (x.key === 'angry' || x.key === 'hurt' || x.key === 'fierce') x.I = round3(clamp(x.I + grv * (x.key === 'angry' ? 0.25 : 0.12), 0, 1))
          else if (x.key === 'shy') x.I = round3(clamp(x.I * (1 - 0.5 * grv), 0, 1))
        }
      }
      // 攒够了就自己起火：同一件事一再越界，不用再等评价"够不够负"，气已经在了
      if (grv >= 0.18 && Number(appr.normFit) <= -0.1) {
        const ai = round3(clamp(0.40 + 1.2 * (grv - 0.18), 0, 0.98))
        const pre = list.find((x) => x.key === 'angry')
        if (pre) pre.I = Math.max(pre.I, ai)
        else list.push({ key: 'angry', label: '生气', I: ai, on: true, half: 35, pad: keyPad('angry') })
        for (const x of list) if (x.key === 'shy') x.I = round3(clamp(x.I * (1 - 0.9 * grv), 0, 1))
      }
      list.sort((x, y) => y.I - x.I)
      topI = list.length ? list[0].I : 0
    }
    if (!list.length || topI < 0.08) return { ok: true, skipped: 'too-weak', emotion: '平常', key: 'normal', mix: [] }
    const why = String(opts.why || opts.cause || '').slice(0, 80)
    const out = applyMix(st, list, why, now, apprUsed)
    const mood = out.mood
    const top = mixTop(out.mix, 1)[0] || { key: mood.key, label: mood.label, e: mood.intensity }
    const epi = { id: 'e' + String(now).slice(-8), at: now, key: top.key, label: top.label, v: mood.v, a: mood.a, d: mood.d, intensity: round3(top.e), why, cause: String(opts.cause || '').slice(0, 120), src: opts.src || 'text', mix: mixTop(out.mix, 4).map((x) => ({ key: x.key, label: x.label, e: x.e })) }
    st.log.push(epi)
    if (st.log.length > MAX_LOG) st.log = st.log.slice(-MAX_LOG)
    saveEmotion(dir, st)
    return { ok: true, emotion: top.label, key: top.key, pad: mood, intensity: top.e, node: null, mix: mixTop(out.mix, 4) }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

/** 此刻是什么心情（已经衰减过的） */
export function affectNow(dir = defaultDir(), now = Date.now()) {
  const st = loadEmotion(dir)
  let mix = mixDecay(st.mix || {}, now)
  // 老文件（还没有 mix）→ 把 mood 当成一条情绪接过来，别一下子变回平常
  if (!Object.keys(mix).length && st.mood && st.mood.key && st.mood.key !== 'normal' && Number(st.mood.intensity) >= FADE_OUT) {
    const m0 = decayMood(st.mood, now)
    if (m0.key !== 'normal') mix = { [m0.key]: { key: m0.key, label: m0.label, e: m0.intensity, half: m0.half || 90, at: now, sat: 0 } }
  }
  const m = moodFromMix(mix, now)
  const ageH = st.mood && st.mood.at ? (now - st.mood.at) / 3600000 : 99
  const list = mixTop(mix, 4).map((x) => ({ key: x.key, label: x.label || moodLabelOf(x.key), e: x.e, half: x.half, sat: Number(x.sat) || 0, via: x.via || '' }))
  return { ...m, octant: octantOf(m), stale: m.key === 'normal' || ageH > 6, updatedAt: Number(st.mood && st.mood.at) || 0, mix: list }
}

/** 最近一次「被撞」本身（不是慢积分后的心情）：强度按时间衰减，默认 3 小时内还算数。
 *  为什么不用 mood.intensity：那是跟基线混过的慢积分，一次猛撞也会被稀释到 0.4 左右，
 *  拿它判"极端情绪"永远判不出来（2026-10-30 实测踩到）。 */
export function episodeNow(dir = defaultDir(), { withinMin = 180, half = 120, now = Date.now() } = {}) {
  const st = loadEmotion(dir)
  const log = Array.isArray(st.log) ? st.log : []
  const e = log[log.length - 1]
  if (!e) return null
  const ageMin = Math.max(0, (now - Number(e.at || 0)) / 60000)
  if (!(ageMin <= withinMin)) return null
  const intensity = round3(clamp((Number(e.intensity) || 0) * Math.pow(0.5, ageMin / Math.max(10, half)), 0, 1))
  return { ...e, intensity, ageMin: Math.round(ageMin) }
}

/** 给 memory_recall 当 mood 参数用：'pad:v,a' */
export function padArg(dir = defaultDir()) {
  const m = affectNow(dir)
  return 'pad:' + m.v + ',' + m.a
}

/** 一句话：此刻心情（给提示词用） */
export function moodLine(dir = defaultDir()) {
  const m = affectNow(dir)
  const list = m.mix || []
  if (list.length <= 1) return m.label + '（强度 ' + m.intensity + '）' + (m.why ? '（' + m.why + '）' : '')
  const txt = list.slice(0, 3).map((x) => x.label + ' ' + Math.round(x.e * 100) + '%').join(' + ')
  return txt + (m.why ? '（' + m.why + '）' : '')
}

/** 三行：心情 / 心里那三个轴 / 为什么（给人格提示用） */
export function emotionLine(dir = defaultDir()) {
  const m = affectNow(dir)
  const list = m.mix || []
  const head = list.length > 1
    ? '此刻：' + list.slice(0, 3).map((x) => x.label + ' ' + Math.round(x.e * 100) + '%').join(' + ') + '（主：' + m.label + '｜' + m.octant + '）'
    : '此刻：' + m.label + '（强度 ' + m.intensity + '｜' + m.octant + '）'
  const lines = [head]
  if (m.key !== 'normal') lines.push('心里：愉悦 ' + m.v + '｜唤醒 ' + m.a + '｜掌控 ' + m.d)
  if (list.length > 1) lines.push('同时在：' + list.map((x) => x.label + '（' + Math.round(x.e * 100) + '%）').join('、'))
  if (m.why) lines.push('为什么：' + m.why)
  return lines.join('\n')
}

/** 最近 24 小时的情绪分布（面板/状态用） */
export function emotionStats(dir = defaultDir(), now = Date.now()) {
  const st = loadEmotion(dir)
  const recent = st.log.filter((e) => now - Number(e.at || 0) <= 24 * 3600000)
  const cnt = new Map()
  for (const e of recent) cnt.set(e.label, (cnt.get(e.label) || 0) + 1)
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, n]) => ({ label, n }))
  const m = affectNow(dir, now)
  return { ...m, count24: recent.length, top24: top, log: st.log.slice(-12) }
}

/** 认知重评（Gross）：最近的负性情绪降一点强度，别一直顶着 */
export function reappraise(dir = defaultDir(), { hours = 24, now = Date.now() } = {}) {
  try {
    const st = loadEmotion(dir)
    let n = 0
    for (const e of st.log) {
      if (now - Number(e.at || 0) > hours * 3600000) continue
      if (!(Number(e.v) < 0) || Number(e.intensity) < 0.25) continue
      e.intensity = round3(clamp(Number(e.intensity) * 0.78, 0, 1))
      e.v = round3(clamp(Number(e.v) + 0.06, -1, 1))
      n++
    }
    if (n) {
      const m = decayMood(st.mood, now)
      if (m.v < 0 || m.intensity > 0.4) {
        st.mood = { ...m, v: round3(m.v + 0.03), intensity: round3(clamp(m.intensity * 0.9, 0, 1)) }
        if (st.mood.intensity < FADE_OUT) { st.mood.key = 'normal'; st.mood.label = '平常'; st.mood.why = '' }
      }
      saveEmotion(dir, st)
    }
    return n
  } catch { return 0 }
}

/* ───────────────── ⑦ 多情绪：同时存在、互相压制/扶持、各自半衰、能过渡 ─────────────────
 * 设计注记（2026-10-31）：不做同情绪 40 分钟冷却，每种情绪都通过公式单独计算被对话、
 * 视频内容等等方面因素的影响后的减弱/增强/情绪转变（情绪不一定是突然转变，也可能是
 * 短时间通过什么情绪过度）。做多情绪机制……感动和开心、害怕和愤怒可以同时存在，
 * 语气也会同时具有多种情绪的说法。
 *
 * 每个 key 一个激活量 e∈[0,1]（不再是一个 mood.key）：
 *   放一会儿：  e ← e·2^(-Δt/half)                  各自半衰，不再共用一个
 *   第一次撞：  e ← I                              首击直达标称强度（不再先打 GAIN 的折）
 *   再撞一下：  e ← e + (1-e)·I·GAIN               已经在里面的才平滑累加
 *   相克的：    弱的 × keep = 1 - min(0.9, w·(0.25 + 0.72·e强))   强者吃掉弱者
 *               差 >0.45 再塌一次 ×0.45 = 突然转变；w 见 applyMix
 *   相近的：    互相喂 FACIL                       感动和高兴会一起亮
 *   转变：      两个不相近时，先点亮中间那个         不是啪一下换，是先过渡
 *   PAD：       基线 + Σe_i(pad_i-基线)/max(Σe,1)   多情绪混出来的三维
 */
export const MULTI = { GAIN: 0.9, FACIL: 0.16, BRIDGE: 0.26, SAT_RISE: 1.12, MIN_E: 0.02, OPPOSE_MIN: 0.35 }

/**
 * ⭐ 2026-11-01（批评图里核对后确认成立的那条）：
 *   SOOTHE   被安抚：他说软话 / 把事情解释清楚，负性情绪额外加速衰减，别死等半衰期
 *   RECALL_W 回忆带回来的情绪：只占很小一份，够"回味"，不许抢现在的主调
 *   （换挡迟滞、负性地板 —— 实测后决定不做，已撤掉，别再加回来）
 */
export const SOOTHE_DECAY = 0.62
export const RECALL_W = 0.18

const KEY_PAD = {}
const KEY_HALF = {}
for (const e of EMOTIONS) {
  if (!KEY_PAD[e.k]) { KEY_PAD[e.k] = e.p; KEY_HALF[e.k] = e.half }
}
KEY_PAD.normal = [BASELINE.v, BASELINE.a, BASELINE.d]
KEY_HALF.normal = 60

export function keyPad(key) { return KEY_PAD[String(key || 'normal')] || KEY_PAD.normal }
export function keyHalf(key) { return Math.max(8, Number(KEY_HALF[String(key || 'normal')]) || 90) }

function padVec(p) { return [Number(p[0]) || 0, (Number(p[1]) || 0) * 0.8, (Number(p[2]) || 0) * 0.5] }
export function padCos(p, q) {
  const A = padVec(p || KEY_PAD.normal), B = padVec(q || KEY_PAD.normal)
  const na = Math.hypot(A[0], A[1], A[2]) || 1
  const nb = Math.hypot(B[0], B[1], B[2]) || 1
  return (A[0] * B[0] + A[1] * B[1] + A[2] * B[2]) / (na * nb)
}
function padDist(p, q) {
  const A = padVec(p), B = padVec(q)
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])
}

/** 评价值暗示的三维（v 在 -1~1，ar 在 0~1，d 在 -1~1） */
export function impliedAffect(a = {}) {
  const cond = Number(a.conduciveness) || 0
  const v = clamp(0.75 * cond + 0.25 * (Number(a.normFit) || 0) + 0.15 * (Number(a.expectation) || 0), -1, 1)
  const ar = clamp(0.55 * (Number(a.urgency) || 0) + 0.35 * (Number(a.novelty) || 0) + 0.25 * Math.abs(cond) + (a.agency === 'other' ? 0.06 : 0), 0, 1)
  const d = clamp(1.3 * (Number(a.control) || 0) - 0.3 + (a.agency === 'self' ? 0.2 : 0), -1, 1)
  return [round3(v), round3(ar), round3(d)]
}

/** 强度（和单情绪那套同一个式子，抽出来给多情绪复用） */
export function coreIntensity(a = {}) {
  const dev = Math.abs(Number(a.expectation) || 0) * 0.5 + Math.abs(Number(a.conduciveness) || 0) * 0.5
  return clamp(0.22 + 0.46 * (Number(a.relevance) || 0) + 0.34 * dev + 0.18 * (Number(a.novelty) || 0) + 0.12 * (Number(a.urgency) || 0) + 0.10 * (Number(a.certainty) || 0), 0, 1)
}

/** 一句话/一段视频 → 同时被点亮的一串情绪（不再只挑第一个命中的） */
export function emotionMixFromAppraisal(raw = {}) {
  const a = {
    novelty: clamp(raw.novelty), relevance: clamp(raw.relevance),
    conduciveness: clamp(raw.conduciveness, -1, 1), expectation: clamp(raw.expectation, -1, 1),
    certainty: clamp(raw.certainty), control: clamp(raw.control), normFit: clamp(raw.normFit, -1, 1),
    urgency: clamp(raw.urgency), care: clamp(raw.care), energy: raw.energy == null ? 0.6 : clamp(raw.energy),
    agency: ['self', 'other', 'circumstance'].includes(raw.agency) ? raw.agency : 'circumstance',
  }
  const strength = coreIntensity(a)
  const imp = impliedAffect(a)
  const best = new Map()
  for (const e of EMOTIONS) {
    const on = e.when(a) ? 1 : 0
    const aff = (padCos(e.p, imp) + 1) / 2
    // 对得上的情绪才有分量；对不上的只是耳边一点余音（以前给 0.10+0.22·aff，害得十几条一起亮）
    const fit = on ? 0.74 + 0.26 * aff : 0.03 + 0.09 * Math.max(0, aff)
    const I = clamp(strength * fit, 0, 1)
    const old = best.get(e.k)
    if (!old || I > old.I) best.set(e.k, { key: e.k, label: moodLabelOf(e.k) || e.label, I: round3(I), on: !!on, half: e.half, pad: e.p })
  }
  const list = [...best.values()].filter((x) => x.I >= MULTI.MIN_E).sort((x, y) => y.I - x.I)
  // 谁更像"这件事的主要反应"：评价里最有信息量的那一维对应的情绪加一点分量
  // （care 高的时候，感动/委屈才是重点；被踩了规矩，生气才是重点；不由着数组顺序排）
  const boost = (k) => {
    if (k === 'moved' && a.care >= 0.5) return 0.22
    if (k === 'hurt' && a.care >= 0.4 && a.conduciveness <= -0.2) return 0.12
    if (k === 'angry' && a.normFit <= -0.3) return 0.18
    if (k === 'scared' && a.control <= 0.3 && a.urgency >= 0.6) return 0.20
    if (k === 'shy' && a.normFit <= -0.2) return 0.10
    if (k === 'lonely' && a.care >= 0.4) return 0.10
    if (k === 'dejected' && a.control <= 0.25 && a.conduciveness <= -0.5) return 0.12
    return 0
  }
  for (const x of list) {
    if (!x.on) continue
    x.I = round3(clamp(x.I + boost(x.key), 0, 1))
  }
  list.sort((x, y) => y.I - x.I)
  // 名次退坡：主调满格，第二 72%，第三 45%，第四 28%，再往后 12%
  // （人不会同时"非常"感动又"非常"害羞；但第二、第三确实还带着）
  const RANK = [1, 0.72, 0.45, 0.28, 0.12]
  let rank = 0
  for (const x of list) {
    if (!x.on) continue
    x.I = round3(clamp(x.I * (RANK[rank] == null ? 0.12 : RANK[rank]), 0, 1))
    rank++
  }
  // 没对上的情绪只留一点点余音，不必都塞进 mix（不然十几条一起亮，主次全糊）
  const kept = list.filter((x) => x.on || x.I >= 0.08)
  return { a, strength: round3(strength), implied: imp, list: kept }
}

export function blankMix() { return {} }

/** 放一会儿（各自半衰），返回新的 mix */
export function mixDecay(mix = {}, now = Date.now()) {
  const out = {}
  for (const [k, x] of Object.entries(mix || {})) {
    const half = Math.max(8, Number(x.half) || keyHalf(k))
    const ageMin = Math.max(0, (now - Number(x.at || now)) / 60000)
    const e = clamp((Number(x.e) || 0) * Math.pow(0.5, ageMin / half))
    if (e < MULTI.MIN_E) continue
    out[k] = { ...x, key: k, e: round3(e), half, at: now }
  }
  return out
}

export function mixTop(mix = {}, n = 4) {
  return Object.values(mix || {}).filter((x) => x.e >= MULTI.MIN_E).sort((a, b) => b.e - a.e).slice(0, n)
}

/** 多情绪混出来的 PAD（权重就是各自的激活量） */
export function blendFromMix(mix = {}) {
  const list = Object.values(mix || {})
  let sw = 0, sv = 0, sa = 0, sd = 0
  for (const x of list) {
    const p = keyPad(x.key)
    sw += x.e; sv += x.e * p[0]; sa += x.e * p[1]; sd += x.e * p[2]
  }
  const den = Math.max(1, sw)
  return {
    v: round3(clamp(BASELINE.v + (sv - BASELINE.v * sw) / den, -1, 1)),
    a: round3(clamp(BASELINE.a + (sa - BASELINE.a * sw) / den, 0, 1)),
    d: round3(clamp(BASELINE.d + (sd - BASELINE.d * sw) / den, -1, 1)),
    intensity: round3(clamp(list.length ? Math.max(...list.map((x) => x.e)) : 0, 0, 1)),
  }
}

export function moodFromMix(mix = {}, now = Date.now()) {
  const top = mixTop(mix, 1)[0]
  const b = blendFromMix(mix)
  if (!top) return { v: BASELINE.v, a: BASELINE.a, d: BASELINE.d, intensity: 0, key: 'normal', label: '平常', why: '', at: now, half: MOOD_HALF_LIFE_MIN }
  return { v: b.v, a: b.a, d: b.d, intensity: b.intensity, key: top.key, label: top.label || moodLabelOf(top.key), why: '', at: now, half: Number(top.half) || keyHalf(top.key) }
}

/** 把一串冲动混进 mix：相克、相近、过渡，最后重算 mood */
export function applyMix(st, list, why, now = Date.now(), appr = null) {
  const mix = mixDecay(st.mix || {}, now)
  const prev = mixTop(mix, 1)[0]
  const items = (Array.isArray(list) ? list : []).filter((x) => x && x.key && Number(x.I) >= 0.05)
  // 刚发生的事是顺还是逆：顺的时候心里那点怨气散得快，逆的时候再好的心情也压不住
  const cond = appr ? Number(appr.conduciveness) || 0 : 0
  const fresh = new Set(items.filter((x) => Number(x.I) >= 0.12).map((x) => String(x.key)))
  if (Math.abs(cond) >= 0.35) {
    for (const k of Object.keys(mix)) {
      if (fresh.has(k)) continue
      const v = Number(keyPad(k)[0]) || 0
      if (v * cond >= 0) continue
      mix[k].e = round3(clamp(mix[k].e * (1 - 0.55 * Math.min(1, Math.abs(cond))), 0, 1))
    }
  }
  // ⭐ 被安抚：他把话说软了、或者把事情解释清楚了（顺 + 合规矩）⇒ 负性额外掉得快。
  //    不是"被哄一下就不难过"，是同样的难过不用再熬满 150 分钟。
  const soothe = Boolean(appr) && cond >= 0.2 && Number(appr.normFit || 0) >= 0.05
  if (soothe) {
    for (const k of Object.keys(mix)) {
      if (fresh.has(k)) continue
      if ((Number(keyPad(k)[0]) || 0) >= 0) continue
      mix[k].e = round3(clamp(mix[k].e * SOOTHE_DECAY, 0, 1))
      mix[k].soothedAt = now
    }
  }
  for (const it of items) {
    const k = String(it.key)
    const cur = mix[k] || { e: 0, half: keyHalf(k), sat: 0, satAt: 0 }
    // 第一次被点着：直接落到标称强度。以前的 ×GAIN 等于入场先打九折，
    // 85% 的新情绪只落 77%，明明更强却压不过一条早就挂在那儿的同等情绪。
    const e = cur.e > 0 ? clamp(cur.e + (1 - cur.e) * Number(it.I) * MULTI.GAIN) : clamp(Number(it.I), 0, 1)
    mix[k] = { ...cur, key: k, label: it.label || moodLabelOf(k), e: round3(e), at: now, half: Math.max(8, Number(it.half) || keyHalf(k)), sat: Number(cur.sat) || 0, satAt: Number(cur.satAt) || 0 }
  }
  // 相克/扶持：只算"最强的那一个对手"，不叠加（叠加会把主调也压没，反而让看热闹的情绪浮上来）
  const snap = {}
  for (const k of Object.keys(mix)) snap[k] = mix[k].e
  for (const b1 of Object.keys(mix)) {
    const B = mix[b1]
    if (B.e < 0.08) continue
    let opW = 0, opCos = 0, frW = 0, frCos = 0
    for (const a1 of Object.keys(mix)) {
      if (a1 === b1) continue
      const A = snap[a1]
      if (A < 0.12) continue
      const cos = padCos(keyPad(b1), keyPad(a1))
      // 相克不只看向量夹角：一正一负本来就是对头（生气 vs 喜悦，夹角并不大，但谁也容不下谁）
      const vb = Number(keyPad(b1)[0]) || 0, va = Number(keyPad(a1)[0]) || 0
      const opp = Math.max(cos < -0.15 ? -cos : 0, vb * va < -0.02 ? 0.45 + 0.45 * Math.min(1, Math.abs(vb * va)) : 0)
      // 强度 × 相克程度 = 压制力；只记最强的那一路，不叠加
      if (opp > 0 && A * opp > opW) { opW = A * opp; opCos = opp }
      if (cos > 0.55 && A * cos > frW) { frW = A * cos; frCos = cos }
    }
    let e = B.e
    // 相克交给下面那道「对立谁强谁吃掉谁」的统一处理，这里只做同向的互相扶持
    if (frW > 0 && frW > B.e) e = e + MULTI.FACIL * Math.min(0.7, frW) * (1 - e) * frCos
    B.e = round3(clamp(e, 0, 1))
  }
  // 对立的两条不能同时高：强者抬头，弱者就被压下去（不是慢慢磨，是吃掉）。
  // 同向的（感动+高兴、害怕+生气这种同为正/同为负的）不走这条，它们可以一起在。
  {
    // 先把所有"互相看不顺眼"的配对找出来，按"谁更占上风"排序，
    // 一条情绪一轮里只被最凶的那个对手压一次（以前是一对一对地过，
    // 90% 的害怕会被 95% 的感动 + 旁边一串陪衬轮着碾到 2%）。
    const ks = Object.keys(mix).filter((k) => mix[k].e >= 0.06)
    const pairs = []
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        const a = mix[ks[i]], b = mix[ks[j]]
        const cos = padCos(keyPad(a.key), keyPad(b.key))
        const va = Number(keyPad(a.key)[0]) || 0, vb = Number(keyPad(b.key)[0]) || 0
        // 对立度：夹角越反越像死对头；一正一负再加一道（生气 vs 喜悦夹角不大，但也容不下）
        const w = Math.min(1, Math.max(cos < -0.1 ? -cos : 0, va * vb < -0.02 ? 0.55 + 0.4 * Math.min(1, Math.abs(va * vb)) : 0))
        if (w <= 0) continue
        // 谁强谁吃。两条几乎一样强（差 ≤0.02）时，这次刚被点着的那条算强：
        // 旧情绪靠"先到"占着位置、新情绪还没衰过就先输，是之前那个边界缺口。
        let hi = a, lo = b
        if (b.e > a.e + 1e-9) { hi = b; lo = a }
        else if (Math.abs(a.e - b.e) <= 0.02 && fresh.has(b.key) && !fresh.has(a.key)) { hi = b; lo = a }
        // 门槛从 0.5 降到 0.35：48% 生气 vs 47% 害羞以前谁都不压，两条对立的一起挂着
        if (hi.e < MULTI.OPPOSE_MIN) continue
        pairs.push({ hi, lo, w, score: w * hi.e })
      }
    }
    pairs.sort((x, y) => y.score - x.score || (x.lo.key < y.lo.key ? -1 : x.lo.key > y.lo.key ? 1 : 0))
    const lost = new Set()
    for (const pr of pairs) {
      if (lost.has(pr.lo.key)) continue
      // 压制力随强者强度走：强者 0.9、对立 1.0 ⇒ 弱者只剩一成多
      const keep = 1 - Math.min(0.9, pr.w * (0.25 + 0.72 * pr.hi.e))
      pr.lo.e = round3(clamp(pr.lo.e * keep, 0, 1))
      // 差距过线 = 突然转变：弱的直接塌，别留半高不低那种别扭
      if (pr.hi.e - pr.lo.e > 0.45) pr.lo.e = round3(clamp(pr.lo.e * 0.45, 0, 1))
      lost.add(pr.lo.key)
    }
  }
  // 2026-11-01：负性地板不做，撤掉强制回收。
  const top = mixTop(mix, 1)[0]
  if (prev && top && prev.key !== top.key) {
    const cos = padCos(keyPad(prev.key), keyPad(top.key))
    if (cos < 0.35 && top.e >= 0.25) {
      let bk = '', bd = Infinity
      const pv = keyPad(prev.key), tv = keyPad(top.key)
      const arMax = Math.max(pv[1], tv[1]) + 0.05
      for (const k of Object.keys(KEY_PAD)) {
        if (k === prev.key || k === top.key || k === 'normal') continue
        // 过路的情绪不该比两头都更激动（不然害羞→生气会硬生生路过"炸毛"）
        if (keyPad(k)[1] > arMax) continue
        const d0 = padDist(pv, keyPad(k)) + padDist(keyPad(k), tv)
        if (d0 < bd) { bd = d0; bk = k }
      }
      if (bk) {
        const c = mix[bk] || { e: 0, half: keyHalf(bk), sat: 0, satAt: 0 }
        mix[bk] = { ...c, key: bk, label: moodLabelOf(bk), e: round3(clamp(c.e + MULTI.BRIDGE * top.e * (1 - c.e), 0, 1)), at: now, half: keyHalf(bk), via: prev.key + '→' + top.key }
      }
    }
  }
  st.mix = mix
  // 2026-11-01：不为了防抖把多情绪融合压成一条 ——
  //   不锁主调、不做"最少停留"：此刻是什么调，就是 mix 里按比重混出来的那个；
  //   防抖这件事交给提示词侧（多种情绪按比重融合说话），不在这里改标签。
  const b = moodFromMix(mix, now)
  st.mood = { ...b, why: String(why || '').slice(0, 80) }
  st.at = now
  return { mood: st.mood, mix }
}

/** 已经喊过一次了：记下当时多强，下次不更强就别再催（这才是冷却，不是定时器） */
export function markSaid(dir = defaultDir(), key, level, now = Date.now()) {
  try {
    const st = loadEmotion(dir)
    const mix = mixDecay(st.mix || {}, now)
    const k = String(key || '')
    if (!k || !mix[k]) return false
    mix[k].sat = round3(clamp(level == null ? mix[k].e : level, 0, 1))
    mix[k].satAt = now
    st.mix = mix
    saveEmotion(dir, st)
    return true
  } catch { return false }
}

/**
 * 2026-11-01：回忆可以影响当下心情，但权重很小
 * 把"当时的感觉"以很小的份量混进此刻的 mix：
 *   · 每条只按 RECALL_W 折算，再乘一个随回忆次数递减的因子；
 *   · 上限压在当前主调的 60% 以下 —— 能回味，但抢不走现在的心情；
 *   · 标 src:'recall'，提示词那边知道这是"回忆带回来的"，不是刚发生的事。
 */
export function feelRecall(dir = defaultDir(), feels = [], now = Date.now()) {
  try {
    const st = loadEmotion(dir)
    const mix = mixDecay(st.mix || {}, now)
    const topNow = mixTop(mix, 1)[0]
    const capE = Math.max(0.12, (topNow ? topNow.e : 0) * 0.6)
    let touched = 0
    for (const f of Array.isArray(feels) ? feels.slice(0, 3) : []) {
      if (!f || !f.key) continue
      const k = String(f.key)
      if (!KEY_PAD[k]) continue
      const want = Math.min(capE, clamp(Number(f.e) || 0, 0, 1) * RECALL_W)
      if (want < MULTI.MIN_E) continue
      const cur = mix[k] || { e: 0, half: keyHalf(k), sat: 0, satAt: 0 }
      // 不叠成一大堆：同一情绪只取"这次回味"和"原来就有"里更高的那个
      const e = Math.max(Number(cur.e) || 0, want)
      mix[k] = {
        ...cur, key: k, label: f.label || moodLabelOf(k),
        e: round3(e), at: now, half: Math.max(8, Math.min(keyHalf(k), 25)),
        src: 'recall', recallAt: now,
      }
      touched++
    }
    if (!touched) return affectNow(dir)
    st.mix = mix
    // 回忆带回来的份量已经压在当前主调 60% 以下了 —— 剩下交给"按比重融合"，不额外锁主调。
    st.mood = { ...moodFromMix(mix, now), why: '翻到点旧事，心里跟着动了一下' }
    st.at = now
    saveEmotion(dir, st)
    return { mood: st.mood, mix, touched }
  } catch { return null }
}

/** 情绪分布的一行说明（给提示词/状态用） */
export function mixLine(dir = defaultDir()) {
  const m = affectNow(dir)
  const list = m.mix || []
  if (!list.length) return '平常'
  return list.slice(0, 3).map((x) => String(x.label || moodLabelOf(x.key)) + ' ' + Math.round(x.e * 100) + '%').join(' + ')
}




/** 直接指定一种心情（工具 emotion_set 用），其余走 feel 的多情绪逻辑 */
export function setMood(dir = defaultDir(), key = 'normal', opts = {}) {
  return feel(dir, { ...opts, key })
}

/** 清空情绪状态，回到气质基线 */
export function resetEmotion(dir = defaultDir()) {
  const st = blankState()
  saveEmotion(dir, st)
  return st
}
