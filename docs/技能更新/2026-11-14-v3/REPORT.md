# 读取skill 0.4.0.1：检查、更新与本地同步

**已完成：本机确实安装并加载了extension-logic-clone，但原DSH/Codex都是旧v1/v2副本。现已按插件v0.4.0的v3/business-flow-v1格式系统更新，备份后同步两处，并验证实际可读。**

## 实际加载与安装

| 位置 | 结果 |
| --- | --- |
| [项目技能](<../../../app/skills/extension-logic-clone/SKILL.md>) | 0.4.0.1，作为本项目canonical source，10文件 |
| [当前DSH加载位置](<C:/dev/sandbox/dsh/data/skills/extension-logic-clone/SKILL.md>) | 已备份更新；skill工具重新加载明确返回v3及read_content.py说明 |
| [Codex本地位置](<C:/Users/carzy/.codex/skills/extension-logic-clone/SKILL.md>) | 已备份更新；直接调用安装内工具实际验证通过 |

备份：[原技能文件](<../../../app/release/skill-backups/extension-logic-clone-before-v3-f7XZiC/>)。两处各10文件与项目hash一致，没有重建loader链接/修改其它技能；个人myskills仓库中原本没有该技能，不擅自更改那套仓库或推送。

## 系统更新内容

1. **主路线改v3**：产品版本与格式版本分开，旧fragment/压缩计算样式与重型派生说明移到legacy参考，不假定新版有旧resources/dictionary布局。
2. **校验补全**：已声明byteAccounting按真实JSONL换行/Unicode字节与唯一内容求和，有seal时核唯一末尾stop、计数和水位；源ZIP身份绑定索引。缺可选声明不冒称已验证。
3. **原字节读取**：新增read_content.py，从eventId＋字面payload字段或contentId提取，重核ZIP身份、清单指定时间线、原事件、引用和size/SHA256；新输出不覆盖、失败清理，不执行内容或自动解码。
4. **事件/业务证据**：明确ui.input/change合并语义、forms真实property和长值field映射、200ms提示、scope.child、iframe/document、截图image/sourceTime、请求bodyText/响应body及CSStext。
5. **范围/预算/复建**：说明policy/coverage/bodyStatus/partial/ready的限界；按需取内容和本地mock，不生成全主题/字段巨型派生，不接真实站点/数据库。事实、推断与运行补全代码分开。

## 验证结果

| 验证 | 实际结果 |
| --- | --- |
| 技能规范 | 项目、DSH、Codex、解压包均通过quick_validate |
| 历史v1/v2读取/重组/解码 | 12项通过 |
| v3格式/引用/账本/封存/身份 | 23项通过 |
| 新原字节读取/篡改/边界 | 11项通过 |
| 合并回归 | npm run test:skill-readers：46/46，43.984秒，exit0 |
| 实际v0.4.0合成包 | 96events、52contents、54校验条目，账本performed |
| 原值提取 | DOM、CSS、PNG、请求/响应正文逐字节一致，未执行 |
| 四个入口 | 项目源、DSH、Codex、独立ZIP解压包都实际跑通 |

独立检查发现内容附件可被被篡改索引冒充时间线事件；先用synthetic包复现原错误，然后限定chunk必须来自manifest.eventChunks并加回归。没有把失败结果隐去。另npm首次Windows单引号模式选中0tests且exit5；已改双引号发现模式，最终真正46test运行通过。

## 使用

```text
$extension-logic-clone 读取 D:\recordings\session.zip，先说明范围和缺口，再整理关键页面、输入前后和接口结果；本次只分析。
```

当前DSH会话重载已确认。其它**已打开**的Codex会话可能仍持有旧说明，请重新加载该技能或新开会话；没有声称所有既有会话都已热更新。只修改读取skill，Chrome无需因为本次技能更新而刷新。

[使用与CLI](<../../技能使用说明.md>) · [新版事件参考](<../../../app/skills/extension-logic-clone/references/business-flow-v3.md>) · [机器验证](<VERIFICATION.json>) · [本地同步回执](<installation.json>)

## 独立技能包

[extension-logic-clone-v0.4.0.1.zip](<../../../app/release/skill-v0.4.0.1/extension-logic-clone-v0.4.0.1.zip>)，39301字节，10文件；SHA256：957961cbb2fdba37b7dd151469b6b6c05a032f07caa1bcdccfa1ff039789ffaa。

ZIP仅技能代码/说明，无记录/索引/密钥。插件版本仍0.4.0，之前完整release与扩展ZIP字节不变；未访问真实业务记录或Chromeprofile。hash证明字节一致，不证明来源认证或业务全覆盖。本项目技能源码与说明按AGENTS同步origin，不代表自动发布新GitHub Release或推送无关技能仓库。
