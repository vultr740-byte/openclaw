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

OpenClaw has a native `skillhub` tool for remote skill discovery and install.

Use it first:

1. Search with `skillhub` using `action="search"` and a focused query.
2. Present the best matches with a short explanation of what each skill does.
3. If the user wants one installed, use `skillhub` with `action="install"` and the chosen `slug`.

Only fall back to the legacy `clawhub` skill/CLI when:

- the native `skillhub` tool is unavailable or disabled
- the remote registry has no relevant result
- the user explicitly asks for `clawhub`

## Search Guidance

When searching, identify:

1. The domain: React, testing, deployment, docs, design, automation, etc.
2. The concrete task: review PRs, schedule reminders, post to Xiaohongshu, fetch GitHub data, etc.
3. The best search terms: short, capability-oriented phrases work better than full sentences.

Examples:

- "make my React app faster" -> search for `react performance`
- "help with PR reviews" -> search for `pr review`
- "I need changelog automation" -> search for `changelog`

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
