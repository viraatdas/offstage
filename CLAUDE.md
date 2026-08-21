# CLAUDE.md

Agentic instructions for this repository live in `AGENTS.md`. Read that file
first; it applies to Claude Code the same as any other agent.

Claude-Code-specific notes:

- The Claude Code plugin (`.claude-plugin/`) ships the `offstage` skill
  (`skills/offstage/SKILL.md`) and registers the MCP server declared in
  `.mcp.json`. When working on the skill or the plugin manifest, keep their
  descriptions consistent with `AGENTS.md` and `README.md` rather than
  re-describing the lanes a third way.
- To drive a local build of the MCP server instead of the published package,
  run `npm run dev:register` from a checkout; it registers a separate
  `offstage-dev` server so it never silently shadows the real one.
