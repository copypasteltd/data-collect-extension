# 后续维护 / Maintenance

## 中文

1. 在 `app/` 中开发和运行测试，文档及公开演示素材放在 `docs/`。禁止使用本地 Docker、WSL 或其他虚拟化环境；测试结束关闭本次打开的浏览器页面和进程。
2. 功能、权限、数据格式或使用步骤变化时，同步更新 `README.md`、`README.en.md`、相关详细文档和 `docs/CHANGELOG.md`。界面变化导致截图或演示过时时，按 [DEMO.md](DEMO.md) 重新生成。
3. 公开素材只能使用虚构数据。不要提交浏览器配置、真实录制包、Cookie、密钥、`node_modules`、`dist` 或临时测试数据。`.gitignore` 是辅助措施，提交前仍需人工检查。
4. 根据改动运行 `npm test`、`npm run build` 及相关浏览器测试。记录失败、限制和未验证的环境；不要把模拟授权测试描述为真实原生授权弹窗已验证。
5. 提交前检查 `git status --short` 和 `git diff --cached`。在用户已授权的范围内提交，并将对应分支及更新说明推送到 `origin`；推送前检查远程状态，避免覆盖他人工作。

## English

1. Develop and run tests in `app/`; keep documentation and public demo media in `docs/`. Do not use local Docker, WSL, or other virtualization environments. Close browser tabs and processes created for the task.
2. For behavior, permission, archive-format, or usage changes, update `README.md`, `README.en.md`, relevant detailed documentation, and `docs/CHANGELOG.md`. Regenerate outdated interface media as described in [DEMO.md](DEMO.md).
3. Use fictional data in public media. Do not commit browser profiles, real recording archives, cookies, credentials, `node_modules`, `dist`, or temporary test data. `.gitignore` is a safeguard, not a substitute for review.
4. Run `npm test`, `npm run build`, and the browser tests relevant to the change. Report failures, limitations, and unverified environments; simulated permission tests are not proof that the native permission dialog was accepted or denied.
5. Review `git status --short` and `git diff --cached` before committing. Within the owner's authorization, commit and push the relevant branch and release notes to `origin`; check remote state first and preserve other people's work.
