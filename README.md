# dsh-emotion-standalone

一个**独立**的 DSH 情绪插件：把「被一句话/一件事撞到 → 评价 → 多情绪混合 → PAD 心情 → 半衰期 → 提示词」这套东西单独打包。

它不依赖 `dsh-memory-net`，不写记忆网，不改 `persona.json`，不联网，也不调用模型。只维护一份自己的 `emotion.json`。

## 它做什么

- **PAD 三维**：愉悦（v）/ 唤醒（a）/ 掌控（d），以及 Mehrabian 的八个分区。
- **OCC + SEC 评价**：一句话先被拆成相关性、顺不顺意、出不出预期、急不急、谁的责任、合不合规矩等维度，再落到具体情绪。
- **多情绪混合**：不是只留一个标签；生气里可以掺着委屈，感动和高兴可以同时在。各自有半衰期，会互相压制/扶持，也会有过渡情绪。
- **心情是慢积分**：一次情绪不会把心情整个翻过去；过几小时会回落到气质基线。
- **可解释**：状态里带 PAD、混合比例、为什么（`why`）。

## 和记忆网里的情绪有什么区别

| | 本插件 | dsh-memory-net 里的情绪 |
|---|---|---|
| 数据 | 自己的 `emotion.json` | 记忆网目录里的 `emotion.json` |
| 记忆节点 | 不写 | 强烈情绪会挂到「我 › 我的心情」 |
| persona | 不碰 | 会镜像 `persona.mood` |
| 依赖 | 无 | 依赖记忆网 / 人格 /  taxonomy |
| 适合 | 想单独要一套情绪的人 | 记忆网/人格那套完整方案 |

## 安装

1. 解压，得到这个目录（里面有 `package.json`、`index.js`、`cordis.patch.yml`）。
2. 在 DSH 里用插件管理安装这个目录：

   ```text
   plugin_manager({ action: "install_bundle", target: "<这个目录的绝对路径>" })
   ```

3. 重启 DSH。
4. 让 agent 调 `emotion_status`，或直接说「看看你现在的情绪」，确认工具已注册。

> 这是 Host-only 插件，没有前端页面；能力通过工具和系统提示提供。

## 工具

| 工具 | 作用 |
|---|---|
| `emotion_status` | 看此刻：PAD、混合、最近 24 小时分布；只读 |
| `emotion_feel` | 被一句话/一件事撞到，记一笔；参数 `text`、`why`、`cause`、`intensity`、`silenceMin`、`energy`、`src` |
| `emotion_set` | 直接指定一种心情（测试/明确要求时用）；`key` + `intensity` |
| `emotion_log` | 翻最近的情绪流水，默认 10 条，最多 50 条 |
| `emotion_reappraise` | 认知重评：把最近一段时间的负性情绪强度压低一点 |

新会话开始时，如果当前不是「平常」，插件会把一行 `【独立情绪状态】` 注入系统提示；平常不注入，省 token。

## 数据

默认：

```text
$DSH_HOME/emotion-standalone/emotion.json
```

`DSH_HOME` 没设时是 `~/.dsh`。也可以用环境变量覆盖：

```text
DSH_EMOTION_DIR=D:\somewhere\emotion
```

`emotion.json` 结构：

```json
{
  "version": 1,
  "at": 0,
  "mood": { "v": 0.16, "a": 0.26, "d": 0.14, "intensity": 0, "key": "normal", "label": "平常" },
  "mix": {},
  "log": []
}
```

删掉这个文件就等于清空情绪；不会影响任何其它插件。

## 设计依据

- PAD：Mehrabian & Russell (1974)；Mehrabian (1996)
- OCC：Ortony, Clore & Collins (1988)
- SEC 评价：Scherer (1984, 2001)
- 情绪时长/消退：Verduyn et al. (2009, 2012)
- 心境一致性：Bower (1981)
- 认知重评：Gross (1998)

强度公式不是某一篇论文直接给的，是把评价理论的几个因子乘起来后做的工程近似；代码里保留了注释，方便改。

## 调规则

- 评价规则在 `lib/emotion.mjs` 的 `APPRAISAL_RULES`（中文正则 → 评价值）。
- 情绪原型在 `EMOTIONS`（key、label、PAD、半衰期、触发条件）。
- 气质基线在 `BASELINE`。
- 想加自己的说话风格，改 `APPRAISAL_RULES` 即可，不需要动插件入口。

## 测试

```bash
node --test test/emotion.test.mjs
```

测试覆盖：被事撞到、心情变化、半衰、重置、工具注册、只在有情绪时注入提示。

## 许可

MIT。见 `LICENSE`。
