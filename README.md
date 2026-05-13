# Entropy Risk Demo

基于信息熵的 RAG 大模型回答风险识别演示系统。

项目目标是把大模型问答过程中的输入、检索和输出数据转化为可量化的不确定性特征，从而判断回答是否应该正常输出、提示确认或进入人工复核。

## 核心功能

- 输入端分析：计算 prompt 的输入端不确定性 `H_prompt`
- 检索端分析：基于本地知识库和联网搜索计算检索熵 `H_ret`
- 输出端分析：基于模型返回的 logprobs 计算输出熵 `H_ans`
- 语义风险分析：判断证据冲突度 `S_conflict` 和敏感度 `S_sensitive`
- 综合风险评分：计算最终风险 `R`
- 模型对比：支持 DeepSeek、SiliconFlow 以及临时自定义 OpenAI-compatible API
- 部署支持：Render、Railway、Docker

## 风险计算公式

```math
R=\min\left(1,\;
0.10H'_{prompt}
+0.23H'_{ret}
+0.22H'_{ans}
+0.28S_{conflict}
+0.17S_{sensitive}
+B_m
\right)
```

三端熵统一映射为：

```math
H'_x=
\left(
\frac{\min(H_x,C_x)}{C_x}
\right)^{1.2},
\quad x\in\{prompt,ret,ans\}
```

其中：

- `H_prompt`：输入端不确定性
- `H_ret`：检索证据分布熵
- `H_ans`：模型输出 token 熵
- `S_conflict`：证据冲突度
- `S_sensitive`：敏感度
- `B_m`：模型先验风险

## 项目结构

```text
.
├── corpus/              # 本地知识库
├── public/              # 前端页面
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── corpus.js        # 知识库加载
│   ├── entropy.js       # 熵计算
│   ├── retrieval.js     # BM25 / 联网搜索 / 证据检索
│   ├── llm.js           # 大模型调用
│   └── risk.js          # 风险融合
├── server.js            # Express 后端入口
├── render.yaml          # Render 部署配置
├── railway.json         # Railway 部署配置
├── Dockerfile           # Docker 部署配置
└── DEPLOY.md            # 部署教程
```

## 本地运行

安装依赖：

```bash
npm install
```

复制环境变量模板：

```bash
copy .env.example .env
```

在 `.env` 中填写 API key，然后启动：

```bash
npm start
```

打开：

```text
http://localhost:5177
```

## 环境变量

常用配置：

```text
OPENAI_API_KEY=你的 DeepSeek API key
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEFAULT_MODEL_ID=deepseek-chat-legacy
SILICONFLOW_API_KEY=你的 SiliconFlow key
SERPER_API_KEY=你的 Serper key
WEB_SEARCH_ENABLED=true
CORPUS_DIRS=./corpus
ALLOW_CUSTOM_MODELS=false
```

说明：

- `SERPER_API_KEY` 用于联网搜索。
- `SILICONFLOW_API_KEY` 用于测试支持 logprobs 的较小模型。
- `ALLOW_CUSTOM_MODELS=false` 适合公开部署，避免陌生人向你的服务器提交 API key。

## 部署

详细步骤见 [DEPLOY.md](./DEPLOY.md)。

简要流程：

1. 上传 GitHub。
2. 在 Render 或 Railway 中连接该仓库。
3. 填写环境变量。
4. 部署完成后使用平台给出的公网 URL。

## 安全注意

不要提交 `.env` 文件。本项目的 `.gitignore` 已经排除 `.env` 和 `node_modules/`。

如果公网开放，建议保持：

```text
ALLOW_CUSTOM_MODELS=false
```

并考虑增加登录、限流和费用监控。

## 开发检查

```bash
npm run check
```
