# .githooks —— 提交 / 推送门禁

启用（每台机器一次）：

```bash
git config core.hooksPath .githooks
```

- `pre-commit`：拦截暂存区的密钥（私钥块 / api key / Bearer token / token= / Slack token）、
  个人本机路径（`C:\Users\<谁>`、`~/.dsh/attachments` 对象 id 等）、误带的产物目录与 `lib/` 构建物、
  以及 `assets/` 之外的图片。
- `pre-push`：要求远端是 github，并对整棵跟踪树重做同一遍扫描。

放行口：`--no-verify`，只给明确知道自己在干什么的紧急情况，事后必须补审。
钩子自身（`.githooks/`）跳过内容自扫，由人工评审。
