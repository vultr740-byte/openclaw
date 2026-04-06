---
name: find-skills
description: Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.
---

# Find Skills

This skill helps you discover and install skills from the OpenClaw skill ecosystem.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might already exist as a reusable skill
- Says "find a skill for X" or "is there a skill for X"
- Asks for a specialized capability that is likely packaged as a skill
- Wants to extend the current agent instead of solving the task ad hoc

## Default Workflow

OpenClaw has a native `skills_search` tool for skill discovery and a `skillhub` tool for install.

Use it first:

1. Search with `skills_search` and a focused query. Let the default `scope="auto"` check installed skills first and remote SkillHub results too.
2. Present the best matches with a short explanation of what each skill does, making it clear whether each match is already installed or remote-only.
3. If the user wants one installed, use `skillhub` with `action="install"` and the chosen `slug`.

Only fall back to the legacy `clawhub` skill/CLI when:

- the native `skills_search` / `skillhub` path is unavailable or disabled
- the remote registry has no relevant result
- the user explicitly asks for `clawhub`

## Search Guidance

Before searching, briefly reduce the user's request to the smallest useful keywords.

- Prefer short, concrete search terms over full sentences.
- Start with the most direct phrasing of the user's goal, not a brainstormed list of related words.
- If the first search is too broad or not relevant, try another nearby phrasing that is still tightly tied to the user's intent.
- Do not claim "no good skill exists" until you have tried a couple of reasonable phrasings.
- If the user asks what you searched, report the queries you actually ran rather than hypothetical alternatives.

## How to Present Results

When you find matching skills, tell the user:

1. The skill name
2. The slug
3. What problem it solves
4. Whether you can install it now

Keep the response short and decision-oriented.

Example:

```text
I found a likely match:

- Calendar (`calendar`): calendar management and scheduling

If you want, I can install `calendar` into the current workspace now.
```

## Installation Guidance

If the user approves installation, use the native `skillhub` tool with the selected slug.

After install:

- Tell the user the skill was added to the workspace skills directory
- Note that it is now available as a normal OpenClaw skill

## If Nothing Matches

If search returns nothing useful:

1. Say no good skill match was found
2. Offer to handle the task directly
3. Optionally mention the legacy `clawhub` path only if that fallback is actually needed
