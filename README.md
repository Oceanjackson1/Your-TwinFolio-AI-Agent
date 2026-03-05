# Your-TwinFolio-AI-Agent

一个基于 Telegram Bot + PDF 知识库 + OCR + 会话记忆的 AI 数字分身项目。

你可以在私聊中创建自己的 Book（知识库分区）、上传 PDF 并提问；也可以把 Bot 拉进群聊，把某个分区绑定到群里，供成员通过 @Bot、回复 Bot 或 `/ask` 进行问答。

## 功能概览

- 多分区知识库
  - `/context` 创建与切换分区
  - 每个分区可单独配置：人格（Persona）、追问方式、回复风格、知识范围、引用开关
- PDF 入库与 OCR
  - 优先读取 PDF 文本层
  - 文本层不足时自动执行 OCR（`tesseract.js`）
  - OCR 支持中英混排，首次会下载并缓存语言模型
  - 解析过程实时回显进度
- 私聊问答
  - 支持基于自己的 Book 提问
  - 支持通过邀请码连接他人 Book 后提问
  - 问答会使用近期会话 + 长期摘要记忆
- 群聊问答
  - 群管理员使用 `/bind` 将群绑定到指定用户的指定分区
  - 支持三种触发方式（@Bot、回复 Bot、`/ask`，可配置）
  - 多人同时提问时可精准 @ 回答提问者
- 文档存储
  - 默认本地落盘（`data/uploads`）
  - 可选上传腾讯云 COS（配置后自动启用）
- 中英文文案
  - `/settings` 一键切换中文/英文

## 技术栈

- Runtime: Node.js + TypeScript
- Bot: Telegraf
- LLM: DeepSeek Chat（LangChain）
- DB: SQLite
- 文档处理: pdf-parse + tesseract.js
- 索引存储: HNSWLib（LangChain）
- 国际化: 内置 i18n（zh/en）

## 项目结构

```text
.
├── src/
│   ├── bot.ts                  # Bot 入口、命令注册、群聊触发逻辑
│   ├── db/
│   │   ├── index.ts            # SQLite 初始化与迁移
│   │   └── services.ts         # 数据访问层
│   ├── i18n/
│   │   ├── zh.ts               # 中文文案
│   │   └── en.ts               # 英文文案
│   └── services/
│       ├── ai.ts               # LLM 与 Embedding 封装
│       ├── askManager.ts       # 问答链路（Prompt + 上下文 + 记忆）
│       ├── contextManager.ts   # 分区与分区设置
│       ├── memoryManager.ts    # 会话摘要与长期记忆
│       ├── ocrManager.ts       # OCR 识别
│       ├── pdfManager.ts       # PDF 解析、切块、检索
│       └── storageManager.ts   # 本地/COS 文件持久化
├── data/                       # 运行时数据目录（可挂载）
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## 环境要求

- Node.js 20+
- npm 10+
- Telegram Bot Token（来自 @BotFather）
- DeepSeek API Key

## 环境变量

复制 `.env.example` 为 `.env`，至少填写以下项：

```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
DEEPSEEK_API_KEY=your_deepseek_api_key
```

完整变量说明：

- 运行身份
  - `AGENT_ID`：实例唯一标识（建议固定）
  - `AGENT_NAME`：实例展示名
  - `BOT_USERNAME`：Bot 用户名（用于运行信息展示）
  - `APP_VERSION`：版本标记
  - `DEPLOY_ENV`：环境标记（production/staging 等）
  - `COMPOSE_PROJECT_NAME`：Docker Compose 项目名
- 数据路径
  - `APP_DATA_DIR`：数据根目录（默认 `./data`）
  - `DB_PATH`：SQLite 文件路径
  - `VECTOR_STORE_DIR`：向量索引目录
  - `OCR_CACHE_DIR`：OCR 模型缓存目录
- OCR
  - `OCR_LANGS`：语言模型，默认 `eng+chi_sim`
- 可选：腾讯云 COS
  - `COS_BUCKET`
  - `COS_REGION`
  - `COS_SECRET_ID`
  - `COS_SECRET_KEY`
  - `COS_BASE_URL`（可选，自定义访问域名）

## 快速开始

1. 安装依赖

```bash
npm install --legacy-peer-deps
```

2. 启动（生产方式）

```bash
npm run start
```

3. 开发模式（热重载）

```bash
npm run dev
```

4. Docker 启动

```bash
docker compose up -d --build
docker compose logs -f polymarket-ai-agent
```

## Telegram 侧必做设置

若要在群聊中稳定接收 @mention 与普通消息，请关闭 Group Privacy Mode：

1. 打开 @BotFather
2. `/mybots` 选择你的 Bot
3. `Bot Settings` → `Group Privacy` → `Turn off`
4. 将 Bot 移出群后重新拉入

## 使用流程

1. 私聊 Bot，执行 `/context` 创建分区并设为激活
2. 直接发送 PDF 文件完成入库
3. 用 `/ask` 或直接发文本提问
4. 如需共享知识库：
   - 拥有者 `/invite` 生成邀请码
   - 访客 `/connect <邀请码>` 接入后即可提问
5. 如需群聊使用：
   - 把 Bot 拉进群
   - 群管理员执行 `/bind` 选择分区
   - 群成员按群配置触发提问

## 指令说明

私聊命令：

- `/start`：开始使用
- `/context`：管理分区（创建/切换/配置）
- `/ask <问题>`：基于知识库提问
- `/invite`：生成或更新邀请码
- `/connect <邀请码>`：连接他人 Book
- `/disconnect`：断开连接
- `/mybook`：查看当前 Book 状态
- `/subscribe`：开通提问权限（当前为应用内标记）
- `/version`：查看运行实例标识
- `/settings`：切换语言
- `/help`：帮助说明

群聊命令：

- `/bind`：绑定群聊到某个知识分区（管理员）
- `/unbind`：解除绑定（管理员）
- `/groupstatus`：查看群聊配置状态
- `/groupsettings`：调整触发方式/权限/风格等（管理员）
- `/ask <问题>`：在允许的触发模式下提问
- `@Bot <问题>`：@ 触发提问
- `回复 Bot 消息`：在允许模式下继续追问

## 数据与持久化

运行后会在 `APP_DATA_DIR` 下生成：

- `database.sqlite`：业务数据（用户、分区、邀请码、群绑定、记忆等）
- `vector_stores/`：分区索引
- `ocr_cache/`：OCR 模型缓存
- `uploads/`：上传 PDF 本地副本

建议将 `data/` 作为持久卷保存，避免重启丢失索引与记忆。

## 当前实现说明（重要）

- Embedding 目前为占位实现（随机向量），语义检索质量有限。
- 检索主链路当前基于关键词匹配得分（非完整 RAG 语义召回）。
- `/subscribe` 当前是应用内订阅标记逻辑，未接入真实支付网关。

如果你要用于生产环境，建议优先改造：

1. 接入真实 Embedding API
2. 增加 rerank/混合检索
3. 接入真实支付与权限系统

## 许可证

仓库当前未提供独立 License 文件。若用于团队外分发或商用，请先补充 License 并明确授权范围。
