# Your-TwinFolio-AI-Agent

一个基于 Telegram Bot、PDF 知识库、OCR 与长期记忆的 **AI 数字分身**项目。

用户可以在私聊中创建自己的 Book、按分区上传 PDF、生成邀请码让别人接入自己的知识库；也可以把 Bot 拉进群聊，让群成员通过 `@Bot`、回复 Bot 或 `/ask` 的方式，基于指定知识分区进行智能问答。

---

## ✨ 核心功能

### 1. Book 与知识分区

- 使用 `/context` 创建和管理知识分区
- 每个分区可独立配置：
  - 人格设定（Persona）
  - 追问方式（直接回答 / 先澄清）
  - 回复风格（简洁 / 平衡 / 详细）
  - 知识范围（严格文档 / 文档 + 常识）
  - 是否展示引用来源
- 上传 PDF 时写入当前激活分区

### 2. PDF 解析与 OCR

- 优先提取 PDF 自带文本层
- 文本不足时自动走 OCR（基于 `tesseract.js`）
- 支持中英文混排识别
- 首次 OCR 会下载并缓存语言模型到 `ocr_cache/`
- 上传过程中实时回写进度

### 3. 私聊问答

- 用户可直接对自己的 Book 提问
- 访客通过邀请码连接他人 Book 后可自由提问
- 有文档的用户无需订阅即可使用问答功能
- 问答上下文包含：
  - 文档检索结果（关键词匹配）
  - 最近会话历史
  - 长期用户画像与滚动摘要
- AI 回复限制为纯文本，避免 Markdown 标记干扰

### 4. 群聊问答

- 将 Bot 拉入群聊后，管理员可执行 `/bind` 绑定分区
- 群聊绑定的是"某个用户的某个知识分区"
- **@Bot 提问时精准回复提问者**：
  - Bot 先发送 `@提问者 🤔 Agent 正在思考中...`
  - AI 生成完毕后更新为 `@提问者\n\n回答内容`
  - 多人同时提问互不干扰，精准 @ 对应用户
- 群管理员可通过 `/groupsettings` 调整：

| 设置项 | 选项 |
|--------|------|
| 使用权限 | 所有成员 / 仅管理员 |
| 触发方式 | `@Bot` / `@Bot + 回复` / `@Bot + 回复 + /ask` |
| 回复风格 | 简洁 / 平衡 / 详细 |
| 知识范围 | 严格文档 / 文档 + 常识 |
| 引用来源 | 开启 / 关闭 |

### 5. 邀请码与 Book 共享

- `/invite` 生成自定义邀请码
- 他人使用 `/connect <邀请码>` 接入你的 Book
- 支持自定义邀请码内容

### 6. 会话记忆

- 保存最近多轮消息历史
- 长期用户画像与会话摘要
- 群聊和私聊分别建立独立 scope
- 群聊会绑定到 `chatId + owner + participant + partition`

---

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript |
| Bot 框架 | Telegraf |
| AI 模型 | DeepSeek Chat (via LangChain) |
| 数据库 | SQLite |
| 文档处理 | pdf-parse + tesseract.js |
| 向量存储 | HNSWLib (LangChain) |
| 国际化 | 自建 i18n（中/英） |

---

## 📁 项目结构

```
.
├── src/
│   ├── bot.ts                  # Telegram Bot 入口 & 命令注册
│   ├── db/                     # SQLite 初始化与数据访问
│   ├── i18n/                   # 中英文文案
│   └── services/
│       ├── ai.ts               # LLM 与 embedding 封装
│       ├── askManager.ts       # 问答主链路（Prompt 构建 + 上下文组装）
│       ├── contextManager.ts   # 分区管理
│       ├── memoryManager.ts    # 长期记忆与会话摘要
│       ├── ocrManager.ts       # OCR 识别
│       └── pdfManager.ts       # PDF 解析、切块与关键词检索
├── ocr_cache/                  # OCR 模型缓存（运行时生成）
├── vector_stores/              # 文档索引（运行时生成）
└── database.sqlite             # SQLite 数据库（运行时生成）
```

---

## ⚙️ 环境变量

复制 `.env.example` 为 `.env`，并填写：

```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
DEEPSEEK_API_KEY=your_deepseek_api_key
OCR_LANGS=eng+chi_sim
```

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取的 Bot Token |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `OCR_LANGS` | OCR 语言模型，默认 `eng+chi_sim`（英文 + 简体中文） |

---

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install --legacy-peer-deps
```

### 2. 启动 Bot

```bash
npm run start
```

### 3. 开发模式（热重载）

```bash
npm run dev
```

### ⚠️ 重要：关闭 Group Privacy Mode

Bot 默认的 Group Privacy 模式会导致无法接收群聊 `@mention` 消息。请务必：

1. 打开 Telegram → 找到 **@BotFather**
2. 发送 `/mybots` → 选择你的 Bot
3. **Bot Settings** → **Group Privacy** → **Turn off**
4. 将 Bot 从群中移除后重新拉入

启动日志会自动检测并提醒此设置状态。

---

## 📋 Bot 命令

### 私聊命令

| 命令 | 功能 |
|------|------|
| `/start` | 开始使用 |
| `/context` | 管理知识分区（创建、配置、切换） |
| `/ask <问题>` | 基于知识库提问 |
| `/invite` | 生成/设置邀请码 |
| `/connect <邀请码>` | 连接他人的 Book |
| `/disconnect` | 断开与他人 Book 的连接 |
| `/mybook` | 查看当前 Book 状态 |
| `/subscribe` | 订阅入口 |
| `/settings` | 语言切换（中/英） |
| `/help` | 显示帮助 |

### 群聊命令

| 命令 | 功能 |
|------|------|
| `/ask <问题>` | 在群里直接提问 |
| `/bind` | 将当前群绑定到某个知识分区 |
| `/unbind` | 解除群聊绑定 |
| `/groupstatus` | 查看当前群绑定状态 |
| `/groupsettings` | 配置群聊回答方式 |

---

## 💬 群聊使用方式

### 绑定流程

1. 在私聊中创建分区并上传 PDF
2. 将 Bot 拉进群聊
3. 群管理员执行 `/bind`
4. 选择一个有文档的分区
5. 群成员开始提问

### 提问方式（取决于群设置）

- `@Bot 你的问题` — @ 提问
- 回复 Bot 消息继续追问 — 上下文追问
- `/ask 你的问题` — 命令提问

### 回复机制

当群成员提问时：
1. Bot 立即回复 `@提问者 🤔 Agent 正在思考中...`
2. AI 生成完毕后，将消息更新为完整回答并 @ 提问者
3. 多用户同时提问时，每个回答精准对应各自的提问者

---

## 🧠 数据与记忆模型

- **ConversationMessages**：保存最近多轮对话消息
- **ConversationScopes**：保存会话摘要（rolling summary）与长期用户画像
- 群聊和私聊使用独立的 scope
- 群聊 scope 绑定维度：`chatId + ownerUserId + participantUserId + partitionId`

---

## 🗺 适合继续迭代的方向

- 更强的文档检索与 rerank（替代纯关键词匹配）
- 接入真实 Embedding API 替代随机向量
- 群聊线程级上下文隔离
- 更细粒度的权限与配额模型
- Web 管理后台
- 多模态输入支持（图片、语音）
- 支付系统集成

---

## 📄 许可证

当前仓库未单独声明 License，默认请在团队内部或得到作者授权后使用。
