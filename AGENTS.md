# Repository workflow

Apply the repository's existing Biome formatter and checks. Run `npm run verify` for runtime or
deployment changes; the Worker has its own generated-binding typecheck and dry-run build.
The real Zammad integration suite requires the Docker stack documented in `test/integration/README.md`.

## Releases

Follow [Cutting a release](README.md#cutting-a-release) before creating a tag or release. The public
tag workflow updates `package.json` and `package-lock.json`, publishes npm and creates the GitHub
release. Contributors do not independently publish package versions. Put migration notes in
`CHANGELOG.md`. This OAuth update requires client reauthorization; see the Worker guide.

Deploy-button repositories independently consume a published version. After publication, update
their package manifest/lock and apply relevant host/configuration changes before redeployment.
Never add AI attribution trailers or rewrite existing commit history.
