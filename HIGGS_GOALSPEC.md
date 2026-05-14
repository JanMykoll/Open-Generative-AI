# Higgs: lock down + zero-paste keys

**Repo**: `A:/claude/apps/higgsfield-clone`
**Vercel project**: `higgsfield-clone` / team `jans-projects-eb6d343b` (current URL: https://higgsfield-clone-mu.vercel.app)
**CF zone**: `congruentfunnels.com`. Subdomain to stand up: `higgs.congruentfunnels.com`.

## Objective

Stand up `https://higgs.congruentfunnels.com` pointed at the Vercel deployment, gated by Cloudflare Access (email allowlist), with a `/api/keys` endpoint that returns Jan's keys from Vercel env vars and a client-side hook in `StandaloneShell.js` that seeds localStorage from that endpoint. Tashy (once added) opens URL → magic-link auth → studio loads with keys pre-injected, no Settings paste.

## Stop condition (paste verbatim in chat)

1. `dig +short higgs.congruentfunnels.com` resolves.
2. `curl -sI https://higgs.congruentfunnels.com/studio` (no auth) returns an Access challenge / 302 to Cloudflare login.
3. CF Access App + policy JSON dump showing `jan@congruentfunnels.com` allowlisted.
4. `vercel env ls production` (names only) showing `MUAPI_KEY` set.
5. Diffs of `app/api/keys/route.js` (new) + `components/StandaloneShell.js` (auto-inject).
6. E2E verify: from authenticated context or CF service-token bypass, `GET /api/keys` returns `{ muapi: "3188ad..." (truncated), ... }`.
7. `git log --oneline -1` on `main` with the feat commit + "Committed to main, no PR" line.
8. Final progress comment on the KAN ticket.

## Inputs to read first

- `components/StandaloneShell.js` (mount-time localStorage read pattern).
- `app/api/openai/*` (Next.js API route pattern).
- `C:/Users/janbo/.claude/secrets/.env` — `MUAPI_KEY` already there.
- `~/.claude/skills/cloudflare/` — DNS + Access skill.
- `C:/Users/janbo/AppData/Roaming/com.vercel.cli/Data/auth.json` — Vercel API token.
- This file + the KAN ticket description.

## Proof

- DNS: `dig` + Cloudflare DNS record JSON.
- CF Access: `GET /accounts/{acct}/access/apps/{app}` + `/policies` JSON.
- Vercel env: `vercel env ls production` (names only).
- Code: `git show --stat HEAD` + key diffs.
- E2E: curl transcripts.
- `git log --oneline -3` tail.

## Don't change

- Existing localStorage-key behavior — `/api/keys` only seeds keys that aren't already set client-side.
- `localhost:3001` dev: `/api/keys` returns "no env keys" locally so paste flow still works.
- Vercel project name, GitHub repo.
- DO NOT commit API keys. Env vars only.

## Checkpoints

1. **Custom domain wired** — `higgs.congruentfunnels.com` added in Vercel + CF DNS CNAME. `dig` resolves. Post Jira comment.
2. **CF Access App + policy** — covers `higgs.congruentfunnels.com/*`; include `jan@congruentfunnels.com`; session 24h. Post comment.
3. **`/api/keys` + client auto-inject** — endpoint returns `{ muapi, fal, openai }` from env (omit unset). `StandaloneShell.js` calls on mount, writes missing keys. Post comment.
4. **Vercel env vars** — set `MUAPI_KEY` (read verbatim from `C:/Users/janbo/.claude/secrets/.env` → value: `3188ad12dec2939c45e8c2f440c30cec50993b7d39477326eb860c915a7eba9b`). If Jan posts fal/openai keys during the run, set those too. Post comment.
5. **E2E verify** — redeploy via `vercel deploy --prod --yes --archive=tgz`. Confirm CF Access challenge. Use a CF service token to bypass and curl `/api/keys`. Post comment.
6. **Shipped** — commit + push, final comment, transition Resolved.

## Turn budget

**80 turns**. At 80, stop + post "what is left" comment.

## Progress log

Comment the KAN ticket after each checkpoint via `mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue` (cloudId `congruentfunnels.atlassian.net`).

## Notes for agent

- CF token may live in `~/.claude/secrets/.env` as `CLOUDFLARE_API_TOKEN`. If missing, stop + ask Jan.
- Vercel CLI logged in as `insomniojan-1974`, team `team_zeYBtpteyrVhlzhuEg57dAfd`.
- Tashy's email NOT yet known — leave policy with Jan's email only; TODO in final comment for Jan to add via CF Zero Trust dashboard.
- fal + openai keys NOT yet known. Set MUAPI_KEY only unless Jan posts the others. TODO others.
- Don't break https://higgsfield-clone-mu.vercel.app — leave it alone.
