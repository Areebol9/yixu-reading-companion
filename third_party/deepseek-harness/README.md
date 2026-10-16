# DeepSeek Harness兼容层来源

来源仓库：<https://github.com/deepseek-ai/deepseek-harness>

固定提交：`21638c56315ae6a2b552d6091945d3144c9af32e`。本目录保留实验WebWorker运行层的五份原始源码及MIT许可，逐文件来源和SHA256见manifest.json。Agent循环和工具等实际包由根目录package-lock.json锁定为0.1.7-rc.2；未把整个桌面产品加入客户端。

`scripts/native-agent-build.mjs`在电脑端校验这些文件，编译并运行上游转换器，覆盖原生应用模块中的异步暂停点。编译器和Acorn不会作为运行时编译器进入手机，手机只执行固定构建产物。

两处上游JSON对象识别比较了V8专用的原生函数字符串格式。构建对dsh-util-values和dsh-tools的指定表达式作严格一次匹配，改为当前JS环境的Object／Array构造器身份检查，保留原型链和有损数据检查。它适用于单一原生JS环境，不接受跨环境对象；原始npm文件保持不变。匹配失败阻止构建，适配原因和原文件哈希记录在构建清单。

`src/native/agent-bootstrap.mjs`只提供已经核对的模块接口：随机UUID、同环境Promise识别、POSIX绝对路径判定及固定包版本；fs/os在当前构建中只有无绑定的导入，不提供文件访问。模型、原文、存储与联网仍通过现有宿主能力和宜序权限控制。没有开放任意Node模块、动态插件或shell。

实际打包组件的许可证与来源记录保存在`.local/native-license-assets/licenses/harness/`，随APK分发。
