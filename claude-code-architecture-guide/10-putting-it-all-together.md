# Chapter 10: Putting It All Together

## The Complete Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAUDE CODE v2.1.81                                │
│                                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │   Plugins    │  │   Settings   │  │  CLAUDE.md │  │  Memory System   │  │
│  │  (skills,    │  │ (permissions,│  │ (project   │  │ (~/.claude/      │  │
│  │   agents,    │  │  model,      │  │  instrns)  │  │  projects/.../   │  │
│  │   hooks)     │  │  plugins)    │  │            │  │  memory/)        │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  └────────┬─────────┘  │
│         │                 │                │                   │            │
│         ▼                 ▼                ▼                   ▼            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    CONTEXT ASSEMBLER                                  │  │
│  │                                                                      │  │
│  │  Gathers all sources → Builds system prompt + system-reminders       │  │
│  │  Registers tools (built-in + MCP + plugin-provided)                  │  │
│  │  Manages conversation history + compression                          │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
│                                     │                                      │
│                                     ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        API REQUEST                                    │  │
│  │                                                                      │  │
│  │  system: [identity_block, instructions_block]  ← CACHED              │  │
│  │  tools:  [Bash, Read, Write, ..., mcp__*, ToolSearch]                │  │
│  │  messages: [                                                         │  │
│  │    { user: [<system-reminder>hook+skills+context</>, user_text] },   │  │
│  │    { assistant: [text + tool_use] },                                 │  │
│  │    { user: [tool_result] },                                          │  │
│  │    ...                                                               │  │
│  │  ]                                                                   │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
│                                     │                                      │
│                                     ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     ANTHROPIC MESSAGES API                            │  │
│  │                POST /v1/messages?beta=true                            │  │
│  │                Stream: SSE                                            │  │
│  └──────────────────────────────────┬───────────────────────────────────┘  │
│                                     │                                      │
│                                     ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     RESPONSE HANDLER                                  │  │
│  │                                                                      │  │
│  │  text blocks → Display to user                                       │  │
│  │  tool_use blocks → Execute tool → Append result → Loop back to API   │  │
│  │                                                                      │  │
│  │  Special tools:                                                      │  │
│  │  - Agent/Task → Spawn sub-agent (new session)                        │  │
│  │  - Skill → Load skill content, return as tool_result                 │  │
│  │  - ToolSearch → Fetch deferred tool schema                           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Building Your Own System: Step-by-Step

### Step 1: System Prompt Design

Create a frozen system prompt in two blocks:

```python
system = [
    {
        "type": "text",
        "text": "You are an AI coding assistant.",
        "cache_control": {"type": "ephemeral"}
    },
    {
        "type": "text",
        "text": """
        # Instructions
        [Your behavioral guidelines]

        # Environment
        <env>
        Working directory: {cwd}
        Platform: {platform}
        Date: {date}
        </env>

        # Tool Usage
        [Guidelines for using each tool]
        """,
        "cache_control": {"type": "ephemeral"}
    }
]
```

### Step 2: Tool Registration

Define tools with JSON Schema:

```python
tools = [
    {
        "name": "bash",
        "description": "Execute shell commands",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Command to execute"},
                "timeout": {"type": "number"}
            },
            "required": ["command"]
        }
    },
    {
        "name": "read_file",
        "description": "Read a file",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        }
    },
    # ... more tools
]
```

### Step 3: System Reminder Injection

Build the first user message with dynamic context:

```python
def build_first_message(user_text, skills_catalog, project_instructions, hook_context):
    reminders = []

    # Hook-injected context (e.g., skill bootstrap)
    if hook_context:
        reminders.append(f"SessionStart hook additional context: {hook_context}")

    # Skills catalog
    if skills_catalog:
        catalog = "The following skills are available:\n"
        for skill in skills_catalog:
            catalog += f"- {skill.name}: {skill.description}\n"
        reminders.append(catalog)

    # Project instructions
    if project_instructions:
        reminders.append(f"# Project Instructions\n{project_instructions}")

    # Build message
    content = []
    for r in reminders:
        content.append({"type": "text", "text": f"<system-reminder>\n{r}\n</system-reminder>"})
    content.append({"type": "text", "text": user_text})

    return {"role": "user", "content": content}
```

### Step 4: The Conversation Loop

```python
messages = []

while True:
    user_input = get_user_input()

    # Build user message with any system reminders
    user_msg = build_user_message(user_input, get_current_reminders())
    messages.append(user_msg)

    # Call API
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=32000,
        system=system,
        tools=tools,
        messages=messages,
        stream=True
    )

    # Process response
    assistant_msg = {"role": "assistant", "content": []}
    for block in response.content:
        if block.type == "text":
            display_to_user(block.text)
            assistant_msg["content"].append({"type": "text", "text": block.text})

        elif block.type == "tool_use":
            assistant_msg["content"].append({
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input
            })

    messages.append(assistant_msg)

    # Execute any tool calls
    tool_results = []
    for block in response.content:
        if block.type == "tool_use":
            result = execute_tool(block.name, block.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result
            })

    if tool_results:
        messages.append({"role": "user", "content": tool_results})
        continue  # Loop back to get model's next response

    # No tool calls = model is done, wait for next user input
```

### Step 5: Sub-Agent Implementation

```python
def spawn_subagent(prompt, agent_type, model=None):
    # Sub-agent gets its own system prompt
    sub_system = build_subagent_system_prompt(agent_type)
    sub_tools = get_tools_for_agent_type(agent_type)

    # Fresh conversation — no parent history
    sub_messages = [
        {"role": "user", "content": [{"type": "text", "text": prompt}]}
    ]

    # Run the sub-agent conversation loop
    result = run_conversation_loop(
        system=sub_system,
        tools=sub_tools,
        messages=sub_messages,
        model=model or default_model
    )

    return result.final_text
```

### Step 6: Skill System

```python
class SkillSystem:
    def __init__(self, skills_dirs):
        self.skills = {}
        for dir in skills_dirs:
            for skill_path in glob(f"{dir}/*/SKILL.md"):
                skill = parse_skill(skill_path)
                self.skills[skill.name] = skill

    def get_catalog(self):
        """Return skill names + descriptions for system reminder"""
        return [
            f"- {s.name}: {s.description}"
            for s in self.skills.values()
        ]

    def load_skill(self, name):
        """Return full skill content (called by Skill tool)"""
        return self.skills[name].content
```

### Step 7: Hook System

```python
class HookSystem:
    def __init__(self, hook_configs):
        self.hooks = {}
        for config in hook_configs:
            for event, handlers in config["hooks"].items():
                self.hooks.setdefault(event, []).extend(handlers)

    def fire(self, event):
        """Execute hooks and collect context injections"""
        contexts = []
        for handler in self.hooks.get(event, []):
            result = subprocess.run(handler["command"], capture_output=True)
            output = json.loads(result.stdout)
            context = output.get("hookSpecificOutput", {}).get("additionalContext", "")
            if context:
                contexts.append(context)
        return contexts
```

### Step 8: Context Compression

```python
def maybe_compress(messages, token_limit):
    estimated = estimate_tokens(messages)
    if estimated < token_limit * 0.8:
        return messages  # Still within budget

    # Find midpoint, summarize older messages
    mid = len(messages) // 2
    summary = summarize_messages(messages[:mid])

    compressed = [
        {"role": "user", "content": [
            {"type": "text", "text": f"[Previous conversation summary: {summary}]"}
        ]}
    ] + messages[mid:]

    return compressed
```

## Key Architectural Principles

1. **Frozen system prompt + dynamic reminders** — Cache the expensive part, inject the changing part cheaply
2. **Tools as the interface** — Everything the model does goes through tools. Tools are the API boundary.
3. **Sub-agents for isolation** — Don't let one task's context pollute another's
4. **Skills as lazy-loaded behavior** — Catalog is cheap, full content is loaded on demand
5. **Hooks for extensibility** — Plugins modify behavior through lifecycle events, not by patching code
6. **Deferred loading for scale** — List names, load details only when needed

## What Makes This Architecture Work

The genius of Claude Code's architecture is its **layered context injection**:

| Layer | What | Where | When |
|-------|------|-------|------|
| System prompt | Core behavior | `system` parameter | Session start (cached) |
| Tool definitions | Capabilities | `tools` parameter | Every turn |
| System reminders | Dynamic context | First user message text | Every turn |
| Skills (catalog) | Available behaviors | System reminder | Every turn |
| Skills (content) | Specific behavior | Tool result | On demand |
| Hook output | Plugin context | System reminder | SessionStart/Compact |
| Sub-agent context | Task instructions | Sub-agent messages | On dispatch |

Each layer adds context at a different time and through a different mechanism, allowing fine-grained control over what the model knows and when it knows it.
