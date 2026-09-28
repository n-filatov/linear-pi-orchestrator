Review your own diff for **{{item.id}}: {{item.title}}** before it goes to a human.

1. Read the full diff as if it were someone else's pull request. Look for:
   - Dead code, leftover debug output, or commented-out blocks.
   - Logic that does not match the issue's stated intent.
   - Missing error handling, edge cases, or test coverage for the new code.
   - Anything unrelated to this issue that snuck into the change.
2. Check style and naming against the surrounding code, not your own
   preferences.
3. Fix what you find. If something is a judgment call rather than a clear
   bug, leave a short note instead of guessing.
4. Summarize what you reviewed and what, if anything, you changed as a
   result.
