# v3 业务证据：事件与关联

以下字段对应v0.4.0实际生产入口，不是历史全采集schema。未知新字段保原事件，不推导未声明的能力；内容字段应先在content_refs中确认是否captured，不能预设存在。

## 页面实例和顺序

事件公共字段id/sessionId/seq/time/kind/payload及可选tabId/frameId/documentId。按session+tab+frame+document划分，同URL刷新或同URL不同框架仍是独立实例。缺document身份不凭时序补成根页。seq保接纳顺序，time配合查看；不能按时间重排后丢原seq。

| 事件 | 当前主要字段／内容字段 | 能得出的结论与边界 |
| --- | --- | --- |
| session.start/stop/notice | 根页、profile、stopOutcome或固定reason | 生命周期/限制，不证明内容无缺口 |
| scope.child | type:child_opened、url、openerTabId、associatedEventId、sourceTime | 记录的子页归因线索；不是所有同域tab都属于流程 |
| page.navigation | committed或内容端导航、url、旧URL等 | 与frame/document核对；导航不等采集器已注入就绪 |
| page.snapshot | sourceHtml内容；forms、viewport、stylesheets、policies、reason、url/title | 一个结构DOM检查点，不是HTTP源码或可执行网页 |
| ui.input / ui.change | target、value、beforeValue?、checked/beforeChecked?、disabled、url | 稳定值或提交变化；快速输入后blur常仅ui.change而不另发ui.input，两者都检查 |
| ui.click/submit/key | target、trusted?、button/key及可知值 | trusted只说明记录端事件标记；不是请求因果或服务器成功认证 |
| ui.scroll | x/y、scope:document/element、target? | 稳定滚动终点，不是完整轨迹 |
| recorder.notice | reason:transient_state、role、action、target、text及隐藏/open/aria等可知状态 | 短暂alert/dialog/menu等原文，可在后续DOM中消失；检查点无该文不能反证没出现 |
| page.stylesheet | href、source:cssom-rules、sha256、text内容 | CSSOM规则文本，可能规范化，不能声称原HTTP/CSS全量 |
| page.resources | urls数组（url/type） | 仅必要资源线索，不是已取得字节或可补下载的授权 |
| page.resource | url/type、source、associatedEventId、body内容 | 从已加载资源读取的样本；按该事件用途解释MIME |
| screenshot | image内容、viewportOnly、reason、associatedEventId、sourceTime | PNG只当前视口，截图有实际采样time，可能合并/滞后 |
| network.request | requestId、url/method/headers/type、bodyText?或bodyStatus | requestId按tab/protocol-hop区分；不复用URL当唯一样本身份 |
| network.response | 同requestId、url/status/headers/mime、body?或bodyStatus | 当前响应正文通常在这里，不必等旧network.finished才取；无正文保缺口 |
| network.websocket | 已确认frame来源的connect/summary、计数与字节量 | 默认无帧正文；未知frame只固定缺口，不推根或复原消息 |

## 表单：property与attribute分开

sourceHtml是采样DOM结构；input的value attribute可能仍是初始值。以同snapshot.forms的value/checked/selected/selectedIndex/disabled/validity及操作事件为准还原当时property。`selector`中的data-flow-node是**这个检查点内部**的定位标记，不能跨检查点当稳定全站ID。

短值可内联；长值可能：

```json
{"forms":[{"selector":"[data-flow-node=...]","value":{"field":"formValue2"}}],
 "formValue2":{"status":"captured","contentId":"<session:hash>","size":3000,
 "sha256":"<hash>","mime":"text/plain;charset=utf-8","category":"dom"}}
```

这不是fragment或嵌套contentId。查询当前snapshot的content_refs字段formValue2后按原字节读取。操作value/beforeValue与提示text也可成为顶层引用；policy对象不是空字符串。beforeValue缺失就是未知，不能用第一份snapshot倒填；target.textPreview只是有界预览，不能证明完整文本。

## 短命状态与视觉

recorder.notice的transient_state是即时轻量证据；action added/changed/removed说明观察结果，不是持续视频时间线。text扫描、每回调数量和字节有限，policy/超限不能假定完整。可用关联文档/seq/time配合近邻snapshot及PNG说明状态，但不声称PNG必定拍到这200ms提示。

DOM可含open Shadow的template shadowrootmode表示、iframe独立来源政策、script/style文本另存政策或节点扫描限。closed-or-no-shadow等不等已读取closed root。CSS与图像资源hash可复用，同URL多内容不能混；样式url()/字体不能自动联网补齐。截图仅视口，不能当整页/Canvas绘图源码。

## 请求和业务结果

按request_id查询全链，再按事件字段取bodyText（请求）/body（响应）；bodyStatus状态与reason保留。响应头/媒体类型说明表示；文本可能由浏览器解码后再UTF-8编码，不当原始HTTP传输字节。Document正文默认以规范DOM替代；非文本/流/超额/缓存不可读不补fetch。

同内容多个请求允许复用一个bin，但不同方法、query、参数、响应/状态及次数都保留。scope.child/screenshot/page.resource的直接associatedEventId可回查原事件；操作与请求仅时间靠近是候选关系，无法据此断言由该操作触发。观察某个201或409只能证明该样本结果，不能推出全部业务规则、鉴权/必填契约。

## 最小分析交付

- 范围/策略与校验结果：版本、batch、实际页面身份、policy/coverage和缺失；不整包转储原值。
- 关键步骤：操作/输入前后、页面/提示/结果、请求样本/状态，逐条附eventId、chunk:line、内容字段/path/hash。
- 样本接口与未知：保相同路径不同样本、拒绝分支，缺正文/未访问/冲突单列；不附自动全主题/字段表。
- 构建时另做真实页面交互验证；分析完成不代表可回放、原站API恢复或复建通过。
