# API配置与适配

设置中为文字批改和图片识别分别填写服务商、模型ID与API Key。未知能力的模型不自动选作识别模型。预设为空时需从服务商控制台填写有权限使用的模型ID。

| 服务商 | 默认基础地址 | 默认协议 |
| --- | --- | --- |
| DeepSeek | https://api.deepseek.com | Chat Completions |
| OpenAI | https://api.openai.com/v1 | Chat Completions（可改Responses） |
| 百炼 | https://dashscope.aliyuncs.com/compatible-mode/v1 | Chat Completions |
| Kimi | https://api.moonshot.cn/v1 | Chat Completions |
| 智谱 | https://open.bigmodel.cn/api/paas/v4 | Chat Completions |
| 硅基流动 | https://api.siliconflow.cn/v1 | Chat Completions |
| Gemini | https://generativelanguage.googleapis.com/v1beta/openai | Chat Completions |
| Claude | https://api.anthropic.com/v1 | Anthropic Messages |

基础地址不含密钥；不得使用含查询参数或用户名/密码的URL。百炼海外/不同区域账户可能需要不同地址，可手动修改。其他兼容服务（如火山方舟、文心、腾讯云或本地模型）可选自定义，填其兼容接口地址及控制台模型/部署ID；仅兼容所选协议，不保证任意专有API可用。

图片以PNG/JPEG/WebP base64传输。Claude转换为原生image块，OpenAI Responses转换为input_image，其余兼容接口使用image_url。文本模型即使连接测试成功，也可能拒绝图片；请另配视觉模型。

自动思考策略：DeepSeek Flash/Pro默认识别Low、批改High；Kimi K3采用相同阶段强度；其他服务商优先使用其默认行为，避免把DeepSeek参数透传到不支持的模型。高级设置可显式选择思考强度；Claude新版模型转换为adaptive/output_config，旧版采用推理token预算。Qwen3使用enable_thinking；Gemini/OpenAI使用对应协议的reasoning参数。部分模型不允许关闭思考或不支持某些强度，请按模型文档配置，发生参数错误时回到“自动”。

JSON自动模式只对明确预设的DeepSeek/OpenAI Chat启用json_object；其他接口以JSON提示词和程序校验为默认。可手动启用接口JSON模式，但必须确认该模型支持。Claude使用提示词JSON，不发送OpenAI response_format。所有批改结果仍经过原有引用、独立错误、分数政策与润色一致性校验，不接受仅因换服务商而放宽校验。

一项任务开始时固定服务商、模型和密钥；修改设置不会改变该任务的重试或结果署名。服务商HTTP错误不回传原始响应，避免泄露回显的凭据或作文。连接测试只发固定短文本且由用户显式触发，不发送历史作文。

## 官方参考（核对日期2026-10-10）

- [DeepSeek思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Gemini OpenAI兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [Claude图像输入](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Claude思考参数](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)
- [百炼思考模式](https://help.aliyun.com/zh/model-studio/deep-thinking/)
- [Kimi快速开始](https://platform.kimi.com/docs/get-api-key)
- [智谱对话补全](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)
- [硅基流动多模态输入](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)
- [Electron本机密钥存储与保护边界](https://www.electronjs.org/docs/latest/api/safe-storage)
