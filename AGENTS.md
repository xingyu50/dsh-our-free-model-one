## 提交前
改完代码运行 `npm run precommit`（三处 typecheck + 生成物一致性 + 全量测试 + manifest 一致性）；红了先修，别推送。

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
