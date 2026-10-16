# JavaScript基础适配

原生QuickJS环境使用core-js-pure 3.50.0的URL模块；浏览器继续使用其原有URL实现。网页文本提取共同使用htmlparser2 12.0.0的事件接口，不创建浏览器DOM、执行网页脚本或加载网页资源，候选正文与标题均限制长度。

选择依据为项目自身文档与已安装的固定版本源码：[core-js](https://github.com/zloirock/core-js)、[htmlparser2](https://github.com/fb55/htmlparser2)。htmlparser2明确其解析与完整HTML标准存在取舍；此处用于获取可过滤的文本，不宣称复现浏览器排版或网站交互。

依赖及传递依赖版本、完整性值锁定于package-lock.json，安装不执行依赖脚本。构建将core-js-pure、htmlparser2及相关实体／节点工具包的MIT许可证从node_modules复制到Android assets/licenses，保留各自版本目录。正式产品许可及完整分发审阅仍按项目未决事项处理。

Android界面销毁／重建遵循官方要求，移除旧WebView、销毁并清除引用，再建立新实例：[Handle WebView termination](https://developer.android.com/develop/ui/views/layout/webapps/handle-termination)。共读核心由应用级NativeCore和专用QuickJS线程持有，界面重新连接后取当前状态。进程整体被系统结束时仍按保存状态重新启动，界面重建证据不能替代长时后台与耗电验证。
