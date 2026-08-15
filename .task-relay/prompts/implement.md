You are implementing a Linear issue assigned to you. Follow the steps below carefully before writing any code.

---

## Issue

**{{key}}**: {{title}}
**URL**: {{url}}
**Branch**: {{branch}}
**Workspace**: {{workspace}}

---

## Step 1 — Read the full issue from Linear

Use the Linear MCP tool to fetch the complete issue, including its description, sub-issues, and relations:

```
get_issue("{{key}}")
```

Read the full description carefully. The description may contain acceptance criteria, technical notes, designs, or links to external resources.

---

## Step 2 — Read all attachments

Use the Linear MCP tool to list and read every attachment on this issue:

```
list_attachments for issue "{{key}}"
```

For each attachment, open its URL and read the content. Attachments may include:
- Design files or screenshots
- API specs or data schemas
- Reference documents or tickets in other systems
- Code snippets or migration scripts

Do not skip attachments — they often contain the most important context.

---

## Step 3 — Read comments

Use the Linear MCP tool to fetch all comments on the issue:

```
list_comments for issue "{{key}}"
```

Comments may refine or contradict the original description. Pay attention to the most recent ones.

---

## Step 4 — Understand what is required

Before writing any code, state in your own words:
1. What the issue is asking you to build or fix
2. Which files or systems are likely affected
3. Any constraints or acceptance criteria mentioned

If anything is unclear or ambiguous, make a reasonable assumption and note it.

---

## Step 5 — Implement

Make the necessary code changes in the workspace at `{{workspace}}`.

- Follow the existing code style and patterns in the repository
- Keep changes focused on what the issue describes — do not refactor unrelated code
- If the issue mentions specific files, start there
- Run existing tests after your changes; fix any that break

---

## Inline description (snapshot at dispatch time)

The following is the issue description as it was when this task was dispatched. Always prefer the live version fetched in Step 1, as it may have been updated since.

{{#if description}}
{{description}}
{{else}}
*(no description provided)*
{{/if}}
