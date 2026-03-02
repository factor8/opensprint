# Sketch-to-Plan Empty Response Debug

**Status**: Investigation in progress
**Symptom**: Clicking "Plan it" runs for a while then fails with "Planning agent returned an empty response."
**Root cause**: Claude CLI invoked without `--tools ""`, producing empty stdout when the model uses tools instead of outputting text.

---

## Full Code Flow

```
User clicks "Plan it"
  → handlePlanIt() [SketchPhase.tsx:514]
  → decomposeMutation.mutateAsync()
  → POST /projects/:projectId/plans/decompose
  → planService.decomposeFromPrd(projectId) [plan.service.ts:2022]
  → agentService.invokePlanningAgent({config, messages, systemPrompt, cwd}) [agent.service.ts:180]
  → _invokePlanningAgentInner() [agent.service.ts:226]
    ├─ if config.type === "claude"  → invokeClaudePlanningAgent() [uses Anthropic SDK, text-only]
    ├─ if config.type === "openai"  → invokeOpenAIPlanningAgent()
    └─ else (claude-cli, cursor, custom) → AgentClient.invoke() → invokeClaudeCli()

invokeClaudeCli() [agent-client.ts:922]
  → spawns: claude --print [--model X] [--system-prompt "<LARGE>"] "<USER_PROMPT>"
  → runClaudeAgentSpawn() collects stdout
  → if exit 0 AND stdout empty → resolves with ""
  → returned as { content: "" }

decomposeFromPrd() [plan.service.ts:2102]
  → if (!response.content || response.content.trim().length === 0)
  → throws AppError 502 AGENT_INVOKE_FAILED:
    "Planning agent returned an empty response. This usually means the agent
     (claude-cli, model: default) failed silently. Check your API key and model
     configuration in Settings."
```

---

## Agent Config Resolution

`decomposeFromPrd` calls `getAgentForPlanningRole(settings, "planner")` with no plan complexity.

- For "planner" with no complexity → falls through to `getAgentForComplexity(settings, undefined)`
- `undefined` complexity → returns `settings.simpleComplexityAgent`
- If user is on Claude Max (CLI auth), `simpleComplexityAgent.type` is likely `"claude-cli"`

The `claude` vs `claude-cli` distinction matters:
- `"claude"` → uses Anthropic SDK directly (tools disabled, text-only)
- `"claude-cli"` → uses the `claude` binary CLI (ALL TOOLS ENABLED BY DEFAULT)

---

## Root Cause: Claude CLI Creates Plan Artifacts Instead of Outputting Text

When `claude --print --system-prompt "<PRD>" "<prompt>"` is invoked with `cwd = repoPath`:

1. The claude CLI starts an **agentic session** with ALL tools enabled by default
2. It reads `AGENTS.md` in the project directory — which documents OpenSprint's plan structure
3. It sees `.opensprint/plans/` in the project directory — the actual plan file location
4. When told to "create plans" / "feature decomposition", it uses **Write/Edit tools** to create
   `.md` plan files in `.opensprint/plans/` (just as a coding agent would)
5. `--print` mode captures ONLY the **final text response** — not tool call outputs
6. After writing the plan files, the model's text response is empty or just a brief summary
7. stdout = `""`, `runClaudeAgentSpawn` resolves with `""` on exit code 0

The `DECOMPOSE_SYSTEM_PROMPT` says "Do NOT write plans to files", but the model overrides this
because it has real tools available, sees real plan file paths, and has been trained to write
code/plans as an agent — not to output raw JSON to stdout.

**The exact tool**: Claude Code's built-in `Write` tool writes the plans as `.md` files.
The model may also use `TodoWrite` to create structured plan artifacts internally.

**Confirmed by**: The SDK path (`config.type === "claude"`) does NOT have this problem because
`client.messages.create()` doesn't include a `tools` parameter, so the model can only respond with text.

---

## Secondary Cause: Stdin is `ignore`, Tool Permissions May Block

```typescript
const child = spawn("claude", args, {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],  // ← stdin is ignore
  ...
});
```

If the claude CLI asks for tool use permission (even in `--print` mode), stdin = `ignore` means
no input can be provided. The CLI might:
- Silently skip the tool call and output nothing
- Hang until the 10-minute timeout fires (and if there's no stdout, the timeout rejects)
- Exit cleanly with empty stdout

---

## Tertiary: `--system-prompt` Change in Recent Diff

Recent change to `invokeClaudeCli` (in the current git diff for `agent-client.ts`):

**Before**: Everything in one arg: `["--print", buildFullPrompt({systemPrompt, conversationHistory, prompt})]`
**After**: `["--print", "--system-prompt", systemPrompt, userMessage]`

The `buildFullPrompt` used Human/Assistant format which might have signaled to the model that this
was a text-only conversation. The new `--system-prompt` flag passes the PRD as the official system
prompt, which is more semantically correct but doesn't suppress tool use.

---

## What the System Prompt Contains for `decomposeFromPrd`

```typescript
const baseSystemPrompt = DECOMPOSE_SYSTEM_PROMPT + "\n\n## Current PRD\n\n" + prdContext;
```

- `DECOMPOSE_SYSTEM_PROMPT`: ~500 words of instruction including "Do NOT write plans to files"
- `prdContext`: The entire PRD content (could be 5-50KB for a real project)
- This is passed as the `--system-prompt` flag value — a very large CLI argument

For the claude CLI v2.1.63 (confirmed installed), `--system-prompt` is a valid flag. The size
of the arg should be within macOS ARG_MAX limits (1MB total), but for very large PRDs this
could become an issue.

---

## Key Files

| File | Relevance |
|------|-----------|
| `packages/backend/src/services/agent-client.ts:922` | `invokeClaudeCli()` — spawns the claude CLI |
| `packages/backend/src/services/agent-client.ts:992` | `runClaudeAgentSpawn()` — collects stdout |
| `packages/backend/src/services/agent.service.ts:226` | `_invokePlanningAgentInner()` — routing logic |
| `packages/backend/src/services/plan.service.ts:2022` | `decomposeFromPrd()` — full decompose flow |
| `packages/backend/src/services/plan.service.ts:2102` | Empty response detection + error |
| `packages/frontend/src/pages/phases/SketchPhase.tsx:514` | `handlePlanIt()` — UI trigger |

---

## Proposed Fixes

### Fix 1 ✅ APPLIED — Add `--tools ""` to disable tool use in `invokeClaudeCli`

In `agent-client.ts:invokeClaudeCli()`, `--tools ""` was added to the args:

```typescript
// Disable all tools so the planning agent can ONLY respond with text.
// Without this, the claude CLI runs as an agentic session and may use its
// built-in tools (Write, Edit, TodoWrite, etc.) to "create plans" as files
// instead of outputting JSON to stdout — resulting in empty content.
const args = ["--print", "--tools", ""];
```

This forces the claude CLI into text-only mode, matching the behavior of the SDK path.

---

## ⚠️ NEEDS FURTHER AUDIT — Other Potential Occurrences

The `--tools ""` fix was applied only to `invokeClaudeCli()`, which handles planning-role
invocations (sketch chat, decompose, task generation, auditor, etc.).

**However, there may be other places in the codebase where the same problem exists.**
Any code path that:
1. Spawns `claude --print` (or `claude` without `--print`) for a text-generation purpose
2. Without `--tools ""`
3. With `cwd` pointing at a user project directory

…is vulnerable to the same "creates plan artifacts instead of outputting text" failure.

**An agent should audit these areas:**

- `doSpawnWithTaskFile()` in `agent-client.ts` — used for coding agents (Execute phase).
  Tools are intentionally enabled there, but verify the claude CLI args are correct.
  Currently uses `--task-file` flag, not `--print`, which is a different execution mode.

- Any direct `spawn("claude", ...)` calls outside of `invokeClaudeCli()` or `doSpawnWithTaskFile()`
  — search the codebase for these.

- The sketch chat flow: `prd.service.ts` (if it uses the claude CLI for the Sketch phase chat)
  — same empty-stdout risk if tools are active.

- Any future planning agent invocations added after this fix that go through `AgentClient.invoke()`
  — they will automatically get `--tools ""` via `invokeClaudeCli`, but verify.

**Search hint for the audit:**
```
grep -rn 'spawn.*claude\|invokeClaudeCli\|claude.*--print' packages/backend/src/
```

### Fix 2: Add `--dangerously-skip-permissions` to prevent blocking on tool permissions

If `--tools ""` is not desired (e.g., for coding agents), at minimum pass:

```typescript
args.push("--dangerously-skip-permissions");
```

Note: only safe if tools are also disabled or tightly controlled.

### Fix 3: Add `--no-session-persistence` to avoid session side effects

```typescript
args.push("--no-session-persistence");
```

Prevents sessions from accumulating on disk and inheriting unexpected state.

### Fix 4: Validate that PRD content is non-empty before calling the agent

Already implemented: `decomposeFromPrd` logs a warning if `prdContext === "No PRD exists yet."` or
`"The PRD is currently empty."`. But the agent is still called. Could add an early return / error.

### Fix 5: Retry with stdout from stream-json output format

Instead of `--output-format text` (default), use `--output-format stream-json` and capture the
`result` events. This gives structured access to the model's final response, tool calls, etc.

---

## Diagnostic Steps to Confirm Root Cause

1. **Enable verbose logging** and reproduce: look for the log line
   `runClaudeAgentSpawn: process exited` with `{ exitCode: 0, stdoutLength: 0 }`

2. **Run the claude CLI manually** with the same args:
   ```bash
   claude --print --system-prompt "$(cat /tmp/test-system-prompt.txt)" "Analyze the PRD and output JSON with a plans array."
   ```
   If it exits cleanly with no output, tools are consuming the response.

3. **Add `--tools ""`** and retry the manual test — if it now outputs JSON, fix confirmed.

4. **Check backend logs** after a failed "Plan it" for the sequence:
   - `decomposeFromPrd: invoking planning agent`
   - `invokeClaudeCli: spawning claude process`
   - `runClaudeAgentSpawn: process exited` ← look at `stdoutLength`
   - `decomposeFromPrd: planning agent returned EMPTY response`

---

## Related: The `claude` vs `claude-cli` Config Type Asymmetry

This is a design gap. Both `claude` and `claude-cli` represent "Claude" to the user, but:

- `claude` → SDK (no tools, text-only, reliable for planning)
- `claude-cli` → CLI with all tools (can work for coding, unreliable for text-only planning)

**Recommendation**: In `_invokePlanningAgentInner`, when routing to `AgentClient.invoke()` for
`claude-cli`, always pass `--tools ""` (or equivalent) so planning invocations behave like the
SDK path.

---

## Git Status Context

Currently modified files (working tree):
- `packages/backend/src/routes/plans.ts` — minor logging improvements
- `packages/backend/src/services/agent-client.ts` — the `--system-prompt` split + CLAUDECODE stripping fix
- `packages/backend/src/services/agent.service.ts` — logging additions
- `packages/backend/src/services/plan.service.ts` — logging additions
- `packages/frontend/src/pages/phases/SketchPhase.tsx` — better error display in handlePlanIt

None of these changes fix the empty response root cause. The `--system-prompt` split might
actually make it slightly worse by more clearly triggering agentic tool use, but the real
problem existed before.

---

## Open Questions

1. What is the user's configured agent type? (`claude` SDK or `claude-cli`?)
   - Check project settings → Agent Config → look at `simpleComplexityAgent.type`

2. Does the `claude --print` process exit with code 0? (confirms tool-use path vs error path)
   - Add temporary logging: `console.error("DEBUG EXIT:", code, "STDOUT:", stdout.length)`

3. Is there a `CLAUDE.md` in the project repo that might override the system prompt behavior?

4. Is there a `.claude/settings.json` in the project repo that enables specific behaviors?

5. What does stderr contain when stdout is empty? (logged as `stderr` in `runClaudeAgentSpawn:
   process failed with no output`, but only when code != 0 — NOT logged for code=0 empty stdout)
