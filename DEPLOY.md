# Entropy Risk Demo 部署说明

这个项目已经整理成可公开部署的 Node/Express 应用。

## 项目结构

- `server.js`：后端 API 和静态文件服务
- `public/`：前端页面
- `src/`：熵计算、检索、LLM 调用、风险融合
- `corpus/`：本地知识库 Markdown 文件

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:5177
```

## Render 部署

最简单方式：

1. 上传到 GitHub。
2. Render 新建 `Web Service`。
3. 选择这个仓库。
4. Render 会自动识别 `render.yaml`。
5. 在 Environment 里补充密钥：

```text
OPENAI_API_KEY=你的 DeepSeek key
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEFAULT_MODEL_ID=deepseek-chat-legacy
SILICONFLOW_API_KEY=你的 SiliconFlow key
SERPER_API_KEY=你的 Serper key
WEB_SEARCH_ENABLED=true
CORPUS_DIRS=./corpus
ALLOW_CUSTOM_MODELS=false
```

部署完成后，Render 会给一个公网 URL。

## Railway 部署

1. 上传到 GitHub。
2. Railway 新建项目并连接仓库。
3. Railway 会读取 `railway.json`。
4. 在 Variables 中填写 `.env.example` 里的变量。
5. 部署完成后绑定 Railway 提供的公网域名。

## Docker 部署

```bash
docker build -t entropy-risk-demo .
docker run --env-file .env -p 5177:5177 entropy-risk-demo
```

## 公开部署安全建议

- 不要上传 `.env`。
- API key 只放在部署平台的环境变量里。
- `ALLOW_CUSTOM_MODELS=false` 适合公开演示，避免陌生人把 API key 输入到你的服务器。
- 如果要给可信同学测试不同 key，可以临时设置 `ALLOW_CUSTOM_MODELS=true`。
- 若长期公开，建议增加登录或限流，否则你的后端 API 可能被频繁调用产生费用。

## 常用命令

```bash
npm run check
npm start
```
