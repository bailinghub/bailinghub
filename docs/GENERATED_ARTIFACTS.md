# 本地智能体附件空间：让生成结果进入业务流程

本功能为待发布候选。需要配套 Core、Agent Client SDK 与客户端宿主；当前公开 0.7.0 / 0.5.0 包不含这部分实现。

## 解决什么问题

本地智能体已经能生成图片，但生成结果往往停留在客户端目录中。需要交给业务系统使用时，用户还要下载、上传，再把地址贴回对话。

附件空间连接“本地生成结果”和“业务可用地址”：宿主登记当前会话获准使用的图片，智能体按引用选择附件和目标授权，中枢保存图片并返回 URL。智能体随后可把地址交给已经接入的业务工具，无需用户手动搬运。

首期交付会话级图片登记、受控上传和原上传结果恢复，支持 PNG、JPEG、WebP。名称中的“附件”描述通用用途，不表示本期已支持 PDF、Word、视频或所有文件格式。

| 场景 | 附件空间解决的步骤 | 业务工具负责的步骤 |
| --- | --- | --- |
| 制作活动海报 | 保存海报并取得可用地址 | 把地址设为活动页或内容封面 |
| 生成经营图表 | 保存 PNG 图表并取得可用地址 | 将图表关联到报告或运营页面 |
| 维护商城商品 | 保存多张商品展示图并逐项返回结果 | 设置主图、轮播图或其他图片字段 |

这些业务动作需要对应系统已经提供接收图片 URL 的能力，不是中枢内置的业务接口。图片生成服务仍由客户端选用。

## 上传完成后发生什么

流程为：生成图片 → 登记会话附件 → 上传到所选授权对应的存储 → 取得 ready URL。到这里附件上传已完成，后续业务操作可以直接使用这些 URL。

正常成功后不需要为了每次使用而重复查询或上传。只有上传结果不确定、重新打开会话需要恢复回执时，才查询原上传记录。批量上传返回逐项结果，已成功项复用原地址，失败项按原记录恢复。

业务工具调用是独立动作，沿用原授权和审批规则，是否完成以业务回执为准。例如设置完整图片列表前先确认所需图片全部 ready，并保留用户未要求删除的已有图片。

## 管理员在哪里开启

1. 在“媒体存储”登记普通 COS 或 OSS：桶名、地域、凭据、公开访问地址、写入前缀。OSS 使用 V4 签名，地域如 `cn-shanghai`；COS 如 `ap-shanghai`。自定义 endpoint 留空即可；填写时须为完整桶访问主机，包含桶名。
2. 打开“智能体客户端 → 配置接入 → 工具与审批”，选择工作空间，在“生成图片上传”启用并选择已登记存储。
3. 客户端安装配套 SDK/DSH，接入生成产物目录与持久恢复记录。业务工具自身仍在原工具源、scope、写操作清单和审批规则中配置。

也支持显式登记服务器本地存储。用于本能力时填写能访问该实例 `/uploads` 的完整公开地址；不会因桶缺失或停用自动换到其他存储。

文件保留由私有化部署方管理，本功能不设置到期时间，不随会话结束或授权撤销清理文件。没有额外“永久保存”判定。第一期用于公开展示图片；上传对象采用公开读取，不要用来上传私有文档。

工作空间配置示例：

```json
{
  "agent_client": {
    "enabled": true,
    "artifact_upload": {
      "enabled": true,
      "bucket": "agent-attachments",
      "max_bytes": 6291456,
      "allowed_mimes": ["image/png", "image/jpeg", "image/webp"]
    }
  }
}
```

默认关闭。第一期 PNG/JPEG/WebP，单图不超过 6 MiB，客户端每批最多 8 张，可配置更小上限。实际文件头、摘要、字节数与声明不符会拒绝；不接收路径、任意远端 URL 或模型上下文中的 base64 文件。

## 接口与恢复契约

认证使用原 Agent Session Bearer。每次请求重新校验接入方、会话、workspace 与 audience；SDK/DSH 进一步固定并整组验证用户显式选定的授权，任何原成员失效都不切换默认或降级子集。

- `POST /agent-api/v1/workspaces/{workspace}/artifacts/{upload_id}`：原始图片字节；`Content-Type` 为 MIME。`x-bailing-artifact` 是下列 JSON 的 UTF-8 base64url 编码（只编码小型元数据，文件不编码进正文）。
- `GET` 同一路径：查询原上传结果。上传 ID 为 64 位小写十六进制。查询不创建业务 run，不执行业务操作。

```json
{
  "name": "campaign-banner.png",
  "mime": "image/png",
  "bytes": 12345,
  "sha256": "<64位文件摘要>",
  "client_conversation_id": "<原会话关联>",
  "client_turn_id": "<原轮次关联>"
}
```

可附 `run_id`，必须属于同一原 Session、workspace、会话和轮次。没有业务 run 时可直接上传，以会话/轮次关联记录，上传不会向其他系统广播正文或创建业务 run。

返回 `schema_version=bailing.agent-artifact.v1`、原标识/元数据、`visibility=public`、`state=ready|pending`。ready 包含 URL 与 `next_action=use_url`；pending 为 `retry_same_upload`。资源记录不返回桶配置、密钥或服务端诊断正文。

同一 Session 的同一 upload_id 固定元数据、内容与存储目标。相同请求重放返回原记录；更换内容或目标返回冲突。网络回包丢失先 GET；ready 直接使用原 URL，pending/未写入才补传原文件。若文件已保存但数据库确认失败，补传可能再次 PUT 同一对象键和相同字节，不生成另一条图片引用；若桶启用版本管理，可能留下存储版本，这是存储层行为。

| 错误 | 下一步 |
| --- | --- |
| artifact_upload_pending / 网络中断 | 查询原 upload_id；必要时补传同一文件到原授权 |
| artifact_content_mismatch / artifact_type_not_allowed / artifact_too_large | 修正文件或配置；不要把无效数据当成功 |
| artifact_conflict / artifact_storage_changed | 保留原记录，核对原文件或存储配置，不自动换桶 |
| artifact_upload_disabled / artifact_storage_unavailable | 在上述集中入口检查开关与存储 |
| artifact_unsupported | 安装配套版本；已有业务工具流程不受影响 |
| 授权失效 | 阻断本会话整组；不换授权重试 |

## 升级边界

新增 `sql/060_agent_artifacts.sql`，只增加图片上传记录表；工作空间开关保存在既有 agent_client JSON 中。自用实例部署时按原迁移流程应用 060。商业 Host 须单独评估配置仓储、租户迁移清单与版本 pin；旧宿主缺少可选 agentArtifacts 仓储时明确 unsupported，不自动部署或迁移其他环境。

商城等业务后端如果已经接收图片 URL，无须为这条链路改变能力声明或审批规则。生成文件的识别、读取与目录持久化由客户端宿主负责，不能假定远端中枢能读取客户端电脑的路径。其他 MCP 宿主/执行器需要各自适配，不因 SDK 新增接口自动获得本地文件权限。

## 与附件上传分开跟踪的已知问题

本次配套候选已补齐[工具限额配置与原调用恢复](TOOL_RATE_LIMITS.md)：按原时间窗口计数，支持继承、自定义或关闭中枢单工具限额；可重试的出站前拒绝保留原参数。恢复仍使用原 invocation，结果不确定的写操作不重发，旧调用丢失的参数也不会被猜补。这不改变 ready 附件的 URL。

DSH 的附件列表源错误目前也可能被通用分类简化为 unknown_failure；上传逐项回执不受该提示问题影响。对应候选仍按这两类结果分别验收，不承诺任意业务批量任务自动完成。

OSS V4 按[官方签名说明](https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4)实现，并与官方 ali-oss 6.23.0 的合成签名向量交叉核验。真实桶连通性在部署方配置存储后验收。
