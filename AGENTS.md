# Harbour Lite contributor guide

This is an independent, public-safe starter. It does not share a repository,
configuration, runtime directory, port, or Git history with another application.

- Work only in this repository. Do not inspect or import personal configuration,
  conversation history, credentials, character assets, or private prompt libraries.
- Never commit `.env`, `data/`, `node_modules/`, local credentials, or personal paths.
- Do not bundle third-party content without an explicit redistribution license.
- Keep model requests on the server, credentials in environment variables, and
  user-configured agent instructions separate from the UI.
- The default demo is offline. Tests must not call paid model services.
- Run `npm test`, `npm run typecheck`, and `npm run audit:public` before publishing.
- Never add Co-Authored-By or AI attribution to Git commits.

Video development is isolated in `demo/`. It may write only to that directory
and `docs/media/`; it must not add runtime dependencies to the main package.
