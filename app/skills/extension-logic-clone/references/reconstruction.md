# 按已观察证据复建与验收

只有用户要求构建时才实施；只读分析不自动创建应用。先检查目标目录、技术栈和已有工作。此流程支持在当前本机做受控展示，不要求建设Docker/WSL/虚拟机，不把隔离环境当产品前置。

## 先建立可追溯输入

先按主流程验证包并解释scope/capturePolicy/budget/coverage/stopOutcome；使用新版事件时阅读[business-flow-v3](business-flow-v3.md)。保存页面实例表(session/tab/frame/document/URL)、关键状态、操作/前后值、请求响应样本与缺口；每条事实附eventId+chunk:line，原内容再附字段/path/sha256。分析只保本任务需要的引用，不把整个bin目录重新展开进巨型JSON/逐属性表。

同URL不同doc、框架、root/child不能合并。seq是接纳顺序而time是采样时间；scope.child的associatedEventId、截图sourceTime/associatedEventId可回查，但相邻请求/操作只视候选因果。未知身份、缺失beforeValue、不可读正文、策略排除、只见一次样本必须保留未知。

## 页面与状态

1. 从合适的page.snapshot提取一个规范sourceHtml，不执行；读取同一snapshot.forms恢复value/checked/selected/disabled等真实property。data-flow-node只在该snapshot内定位，不能跨snapshot永久复用。长值通过forms.value.field转同payload的captured引用。
2. 将关键页面状态映射到实现状态，而不是保存一堆静态HTML冒充工作流。核对输入前后、弹窗/下拉、校验失败、成功与拒绝结果及相关原文提示。transient_state可在后续DOM里消失，保其文字/角色/出现移除证据；不补造未拍到的PNG。
3. 读取对应CSS和必要图像/字体的hash内容；同URL不同版本分别处理。CSSOM规则可能规范化，缺样式或资源不联网补齐。viewportOnly截图作为当时所见参考，不能当整页或绝对像素保证。
4. 保open Shadow结构/框架身份可知范围。缺closed root、frame权限、超限内容或绘图原始数据，明确以替代组件/截图呈现，并注明它不是可编辑原实现。

## 执行前移除原站活动入口

原始HTML/CSS/正文是输入数据，不是可信应用代码。生成新受控组件，或用惰性解析生成本地静态页面；移除原script、on*事件属性、javascript:、meta refresh、base、object/embed、原form action及其它活动导航入口。CSS @import/url、链接/图像/srcset、iframe与字体应只映射到明确验证的本地资源或替代物；对原业务URL不做fetch/POST/WS。

展示采用仅本地/默认拒绝网络的CSP和请求路由，核对实际network日志，不以“我改了URL”当阻外网证明。若为了本地mock保留表单功能，处理器必须是新写本地代码，明确不携带原站认证头/Cookie/令牌，不让未处理的原form默认提交。不要将采集到的外链直接插入具备用户登录态的浏览器。

## 接口与业务逻辑

按已观察方法/路径/query/body/状态与响应维护样本服务。保留同接口不同参数/返回和重复参数，不把相同hash当可以合并所有请求身份。请求bodyText和响应body分别取；缺少正文不补猜。解析JSON或其它格式时保原字节来源，编码或类型不明就不臆造。

新mock的状态机、匹配器、路由、handler及本地测试数据是**为可运行性补全的实现**；能够重建成功/拒绝分支不等恢复服务端源码。只见201/409样本不能推导完整鉴权、必填、权限或账户规则。未访问分支可显示不支持/未知，不静默套成功样本。涉及业务写仅本地模拟，不重放到原网站。

## 真正验收与交付

按用户目标选择已观察的关键路径，实际打开新页面执行：字段前后/Unicode值、必填校验、弹窗/下拉、保存后状态、成功与拒绝响应/状态保持；有框架和子页时验证身份及返回根流程。测试服务端状态与页面可见结果，不能仅比较静态文件或JSON。

视觉核对布局、文案、主要颜色/字体/视口/滚动和对应PNG；缺资源、动态时间、旧属性与真实property差异单列，不把近似写成像素一致。网络日志需证明未访问原站/外部服务；记录实际测试环境/命令/结果和任务自建浏览器/服务的清理。

交付运行方式、已验证路径、证据映射（事实/候选关系/补全代码区分）、原包与内容hash、缺口和未知项。包校验成功、采集策略一致与页面复建通过是三个不同结论。不要声称完整回放、恢复原站源码、登录态、全库、未访问流程或真实后端。
