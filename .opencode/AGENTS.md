# Pre-push checklist

Before committing and pushing, always run these checks in order:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
```

If `format:check` fails, fix with `npm run format` first.
