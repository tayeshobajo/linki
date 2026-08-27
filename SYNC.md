# Trust Tai × Linki — Fork & Sync Strategy

## Remotes
- `origin` → `tayeshobajo/linki` (Trust Tai-owned; production source)
- `upstream` → `moaljumaa/linki` (source of truth for Linki core releases)

## Model: standalone repo carrying a TT patch set, NOT a GitHub fork
This repo was created fresh (not via GitHub's fork mechanism) so it can be
private-first and carry our commits directly on `main`. Treat it as:
`upstream/main` + Trust Tai adapter commits rebased on top.

## Updating from upstream
```
git fetch upstream
git rebase upstream/main        # TT commits: 4818090, 9ec2c05, d8d3b17, ...
# resolve conflicts in pages/api/lookup.ts if LinkedIn DOM changes
npm install && npm run build && npm test
git push origin main
```

## Our commits (isolated, currently 3)
- `4818090` api: POST /api/lookup — flagship people search (TT reachability adapter seam)
- `9ec2c05` fix(lookup): never emit null full_name
- `d8d3b17` fix(lookup): structure-anchored result-card parsing for hashed-class DOM

Our changes live almost entirely in `pages/api/lookup.ts` + `scripts/probe-search-dom2.mjs`
— a deliberately narrow surface so upstream rebases stay cheap.

## Branch policy
- `main` = verified state. Nothing lands without full build + test green.
- Rebase (don't merge) upstream so TT commits stay isolated and readable.
