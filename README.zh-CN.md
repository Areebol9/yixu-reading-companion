# 宜序伴读 · Yixu Reading Companion

[English](README.md) · [简体中文](README.zh-CN.md)

宜序伴读是面向长篇阅读的桌面 AI 伙伴。正文保持简洁，交流在侧栏，段评附在原段后。后台持续整理书籍资料，伙伴分别保留自己的交流与私人记忆。

## 下载与启动

从[公开发行页](https://github.com/Areebol9/yixu-reading-companion/releases)下载 Windows x64 完整便携 ZIP，完整解压后双击 **启动宜序伴读.cmd** 或 **Start Yixu Reading Companion.cmd**。需要 Windows 10／11 x64；包内已有 Electron、Node.js 和运行依赖。

1. 在设置中选择简体中文或 English，语言选择会保存。全新英文存档默认使用小鱼的英文翻译版本；现有存档切换语言不会替换已选伙伴。
2. 导入你有权使用的 TXT，选择当前阅读位置。发行包不含小说、私人存档、聊天或密钥。
3. 模型设置中选择后台模型；伙伴页面独立绑定伙伴模型。填入支持流式响应和工具调用的 OpenAI 兼容服务地址、模型名与自己的 API 密钥。
4. 开始伴读、在侧栏交流，或给具体原段留言并邀请回应。离开原段后，邀请的回复仍会保存到原评论。
5. 暂停后保存已发出的回复；重新打开保留读点和记录，不自动恢复付费模型请求。

模型费用由所选服务商收取，本程序不附赠推理额度。Nebius Token Factory 配置示例及兼容性边界见[英文说明](README.md#nebius-and-nvidia-models)。

## 保存位置与后台运行

默认数据目录为 `%LOCALAPPDATA%\YixuReading\Desktop`，程序会记住所选位置；文件菜单“打开数据目录”可查看实际目录。启动前设置 `YIXU_DATA_DIR` 可选择独立数据根。更新程序时保留数据目录。

“书籍信息”中可以更改并迁移书籍工程目录。工程文件夹供 agents 使用，与书库中保存的导入原文分开。正常迁移、备份、恢复使用客户端已有入口。

通知区域图标可打开主界面和“保存并退出”。重复启动打开同一实例；最小化后不再新增人工已读范围，已受理后台工作继续。有任务时关闭窗口，可选择后台处理或等待当前请求保存后退出。无头 agent 模式使用同一存档，用户随时打开窗口，不抢占鼠标键盘。

## 从源码构建

需要 Node.js 24 及更新版本：

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run build
npm run desktop
pwsh -File scripts/package-client.ps1
```

完整 ZIP 与 SHA-256 校验文件输出到 `artifacts/`。英文与中文启动器调用同一实现。`Agent.cmd`／`代理操作.cmd` 提供无头操作，具体命令见[英文接口说明](README.md#agent-interface)。

## 当前限制

这是开发版。长对话和大量后台输出仍可能等待较久，暂停后的章末内容可能保留待续。后台完成不等于伴读的时机与自然程度已达预期。目前可配置不同伙伴，尚未实现多伙伴同时共读。

## 贡献与许可

反馈问题时请去除密钥、真实小说原文和私人存档。界面改动需兼顾两种语言与阅读区域，存储改动需保留原记录和接续能力。

源码使用 **GPL-3.0-only**，第三方组件保留各自许可。见[LICENSE](LICENSE)与[第三方声明](THIRD_PARTY_NOTICES.md)。
