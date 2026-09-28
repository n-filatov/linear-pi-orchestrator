Verify the change you just made for **{{item.id}}: {{item.title}}**.

1. Run the project's build and test commands. Fix anything that fails because
   of your change; leave unrelated pre-existing failures alone but say so.
2. Re-read the diff against the issue's acceptance criteria. Confirm every
   requirement is actually met, not just plausible.
3. Manually exercise the changed behavior where that is practical (a CLI
   command, an endpoint, a rendered page) instead of trusting the tests alone.
4. Report a short pass/fail verdict: what you ran, what passed, what you had
   to fix, and anything you could not verify and why.

Do not mark verification done unless you actually ran something.
