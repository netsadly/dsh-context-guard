# LM Studio 思考等级：加载与验收注意事项

## 为什么界面选了等级仍可能无效

Harness界面选择被发送，不等于LM Studio实际支持该等级。已测试的Huihui Qwen派生GGUF在直接加载时仅宣告on/off；服务端把low/medium/high降为on，已有模板缺少变量时默认xhigh。直接追加chat_template_kwargs在该环境也未解决。

修复应使用同一GGUF的本地模型定义，把自定义字段送入既有Jinja模板；不需要换权重或把低档偷换成关闭思考。参考[LM Studio model.yaml文档](https://lmstudio.ai/docs/app/modelyaml)。不同模型与版本必须单独验证。

## 本地配置步骤（不随插件自动执行）

1. 任务空闲时保存当前准确模型标识、底层GGUF路径、load配置和prediction配置。记录窗口、GPU、KV、批处理、MTP等；不要只记录界面模型名称。
2. 参照当前LM Studio支持的model.yaml格式，在其本地模型定义目录创建独立定义，base引用**已经下载的同一GGUF来源**。每个customField需要key、displayName、description、type、defaultValue，以及select类型的options。
3. 对支持该变量的模板，定义select字段 `reasoningEffort`，用 `setJinjaVariable` effect 映射到 `reasoning_effort`。选项与模板支持值一致。已测试模板支持low/medium/high/xhigh，其中high转换为xhigh，medium不追加强度指令，默认xhigh。
4. 另定义boolean字段 `enableThinking`，effect映射 `enable_thinking`，默认true。不要复制其他模型的采样/加载配置来代替本机现有参数。
5. 等待模型索引识别定义，列出变体，核对所选变体指向相同底层GGUF；索引校验失败先修正定义，不能直接卸载原模型。字段description缺失会导致定义被拒绝。
6. 确认所有推理任务空闲后才卸载并加载本地定义，传回原load配置。需要保持旧会话时沿用原API identifier；加载后比较前后load和prediction配置，发现差异先排查，不开始批量测试。

本仓库不提供个人model.yaml、模型参数快照或机器路径脚本。以上是配置结构说明，不是可直接复制的本机配置。

## Off必须显式发送关闭值

已验证的Harness适配器会在 `reasoningEfforts.off` 为null时省略关闭值；该LM Studio环境因此继续按默认思考。目标模型应使用字符串映射 `off: none`，使请求实际包含 `reasoning_effort: "none"`。仅修改需要修复的模型条目，保留其他等级，不改全局模型行为。不同服务端接受的关闭值可能不同，先用一次小请求验证。

## 重启和重新加载

**直接重新加载原始GGUF条目可能重新失去三级映射。** 卸载或重启LM Studio后应再次选择带customFields的本地定义，保持同一底层GGUF及原load参数，并确认API identifier仍匹配Harness配置/旧会话。

插件本身只查询已加载模型，不会创建定义、自动重载或恢复参数；发布源码不包含这些本机状态。不要把来源不同的默认参数自动合并进正在使用的模型。

## 如何验收

- 固定提示、温度、seed、输出预算，每档至少两次；检查实际请求字段、服务端是否降级、输入token和输出差异。
- 已测六次对照中，修复前三档均为输入136/输出741；修复后low为124/1143，medium为94/1070，high为136/741，各档两次重复一致。此题low反而更长，说明等级不是严格的时长排序。
- 在Harness实际选择Off执行一次真实工具任务，确认请求显式none、响应思考内容为空且工具正常；再切Medium/High验证请求映射。只看下拉框或HTTP200不够。
- 确认原有窗口、MTP和GPU设置保持。吞吐比较应使用足够长的生成，区分加载、首token、提示处理和生成时间。

若回退，空闲卸载后停用本地定义，再加载原GGUF及此前参数；这也会恢复其原先的等级能力限制。原始会话历史不应被回滚覆盖。
