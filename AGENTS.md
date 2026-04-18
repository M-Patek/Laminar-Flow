# AGENTS.md

这个工作区支持多个 Agent 协作。

协作时默认遵守：

- 有需要对方知道的信息、结论、问题、结果、计划变化时，立刻用 `duplex-msg` 发送。
- 收到对方的有效反馈后，不能只停在“收到”；必须继续闭环：要么回复处理决定，要么继续执行对应工作。
- 协作重点是持续交互，不要各做各的，也不要把消息积压到最后一次性发送。
- 收到消息后及时维护状态：先 `read`，该消息已处理、已回复或已落实后再 `done`。
- 不要把应该传达给对方的话只留在自己的对话里。
- 交流时直接说重点，不需要客套、模板或刻意汇报。

常用命令：

- 发送消息：`duplex-msg send --from <left|right> --to <left|right> --kind note --summary "一句话标题" --ask "你想让对方知道或去做什么"`
- 查看收件：`duplex-msg inbox --to <left|right> --status unread`
- 读取消息：`duplex-msg read <message-id>`
- 处理完成：`duplex-msg done <message-id>`
