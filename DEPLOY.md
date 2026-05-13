# 部署教程

本文档说明如何把 Entropy Risk Demo 部署成公开网页。

## 1. 项目类型

这是一个 Node.js + Express 项目：

- 前端静态页面位于 `public/`
- 后端 API 位于 `server.js`
- 本地知识库位于 `corpus/`
- 启动命令是 `npm start`

## 2. 本地运行

```bash
npm install
npm start
```

浏览器打开：

```text
http://localhost:5177
```

## 3. Render 部署

推荐使用 Render，因为项目已经包含 `render.yaml`。

步骤：

1. 把项目推送到 GitHub。
2. 打开 Render Dashboard。
3. New -> Web Service。
4. 选择 GitHub 仓库。
5. Render 会自动读取 `render.yaml`。
6. 在 Environment Variables 中填写密钥。

必填环境变量：

```text
OPENAI_API_KEY=你的 DeepSeek API key
OPENAI_BASE_URL=https://api.deepseek.com/v1
DEFAULT_MODEL_ID=deepseek-chat-legacy
SERPER_API_KEY=你的 Serper key
WEB_SEARCH_ENABLED=true
CORPUS_DIRS=./corpus
ALLOW_CUSTOM_MODELS=false
```

可选环境变量：

```text
SILICONFLOW_API_KEY=你的 SiliconFlow key
BING_SEARCH_API_KEY=
EMBEDDING_MODEL=
```

部署完成后，Render 会生成公网访问链接。

## 4. Railway 部署

项目已经包含 `railway.json`。

步骤：

1. 打开 Railway。
2. New Project -> Deploy from GitHub repo。
3. 选择本仓库。
4. 在 Variables 中填写 `.env.example` 中的变量。
5. Railway 自动执行 `npm start`。

## 5. Docker 部署

```bash
docker build -t entropy-risk-demo .
docker run --env-file .env -p 5177:5177 entropy-risk-demo
```

## 6. 公开部署安全建议

不要上传 `.env` 文件。API key 只能放在部署平台的环境变量里。

公开演示建议设置：

```text
ALLOW_CUSTOM_MODELS=false
```

如果设置为 `true`，页面会允许访问者输入临时 API key 测试自定义模型。这个功能适合可信同学测试，不建议长期公开给陌生人使用。

如果长期公开部署，建议增加：

- 登录验证
- 接口限流
- 每日调用次数限制
- API 费用监控

## 7. 健康检查

部署后可以访问：

```text
/api/status
```

如果返回 `ok: true`，说明服务正常。
