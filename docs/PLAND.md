# AWS Console Dashboard — build plan

## Context

Working with AWS from Windows Terminal gives no overview of which CLI profiles exist, which
account each one points to, or whether its session is still valid. At work there are many
profiles across several accounts, signed in through SSO; at home there is one account.

The goal is a local dashboard that shows every AWS CLI profile, lets you sign in and switch
between them, run CLI commands, and browse common resources, all without the terminal.
It must work unchanged on both machines.

Decisions already made with you:

- **Form:** local web app, opened in the browser, served from `127.0.0.1` only.
- **Runtime:** Node.js (available on the work PC).
- **First version includes:** profiles and login, a CLI command runner, resource views.
- **Not in the first version:** "open AWS web console" and "open terminal" buttons,
  creating or editing profiles from the UI.

What exists today (checked on this PC):

- Project folder is empty and is not yet a git repository.
- AWS CLI 2.34.9; one profile `default` using `aws login` (`login_session` in
  `~/.aws/config`), region `eu-west-1`, session currently valid.
- No `~/.aws/sso` folder, so SSO cannot be exercised for real on this PC.
- Node 24 and npm 11 are installed.

## Core design choice: the AWS CLI does all AWS work

The server never talks to AWS itself and never handles credentials. Every action runs the
installed `aws.exe` with `AWS_PROFILE` set for the chosen profile. This means:

- Every sign-in type the CLI supports works the same way in the dashboard: SSO,
  `aws login`, access keys from `aws configure`, assume-role chains, `credential_process`.
- Company settings (proxy, custom CA bundle, SSO configuration) are inherited automatically.
- `~/.aws/config` and `~/.aws/credentials` are only read, never written.

## Stack

- **Server:** Node 24, TypeScript, Fastify. Serves the API and the built frontend.
- **Frontend:** React, Vite, TypeScript, TanStack Query for polling and caching, plain CSS.
- **Tests:** Vitest.
- Dependencies kept few, because the work PC may install through a company proxy.

## Layout

```
package.json                 scripts: dev, build, start, test, bundle
server/src/
  index.ts                   start on 127.0.0.1, create session token, open browser
  security.ts                token check, Host and Origin checks
  store.ts                   settings, history, favourites in %APPDATA%\aws-console-dashboard
  aws/
    configParser.ts          read ~/.aws/config and credentials
    profiles.ts              profile model, type detection, grouping
    cli.ts                   the only place that spawns aws.exe
    auth.ts                  session status, login and logout jobs
    commandLine.ts           split typed command text into arguments
    resources/               one small definition file per service
  routes/                    profiles, auth, run, resources
web/src/
  App.tsx                    layout, persistent profile and region selector
  pages/Profiles.tsx, Runner.tsx, Resources.tsx
  components/                ProfileCard, StatusBadge, OutputView, DataTable
  api.ts                     fetch wrapper that adds the token and reads streams
test/fixtures/               sample config files, fake aws executable
```

## How each part works

### Profiles

- `configParser.ts` reads the files named by `AWS_CONFIG_FILE` and
  `AWS_SHARED_CREDENTIALS_FILE`, falling back to `~/.aws/`. It handles `[default]`,
  `[profile x]`, `[sso-session x]` and indented sub-settings.
- From the credentials file it records only that a profile has keys. Key values are never
  kept or sent to the browser.
- `profiles.ts` gives each profile a type from its settings:

  | Setting present | Type | Sign-in action |
  |---|---|---|
  | `sso_session` or `sso_start_url` | SSO | `aws sso login` |
  | `login_session` | AWS login | `aws login --profile X` |
  | access key in credentials | Access keys | none |
  | `role_arn` + `source_profile` | Assume role | follows the source profile |
  | `credential_process` | External process | none |

- Each profile shows name, type, account ID, role, region and session status. Account and
  role come from the config where present (`sso_account_id`, `sso_role_name`, the ARN in
  `login_session`, `role_arn`) and from the status check otherwise.
- SSO profiles are grouped by SSO session, because one sign-in covers every profile in the
  group.
- Search box, pinned profiles, and a colour label per profile (for example red for
  production), stored in the app settings.

### Session status

- Status of a profile comes from `aws sts get-caller-identity --profile X`, with a timeout,
  at most 4 running at once, results cached for 60 seconds.
- For SSO, one check per SSO session is enough, so 50 work profiles do not mean 50 calls.
  Other profiles in the group are checked when opened or on request.
- CLI error text is mapped to a clear state: valid, expired (sign in again), no credentials,
  access denied, network problem.
- Expiry time is read from the `expiresAt` field in `~/.aws/sso/cache` for SSO sessions and
  from the login cache for `aws login`. The exact field names in the login cache are checked
  at implementation time; if they are not usable, the card shows valid or expired without a
  countdown.

### Sign in, sign out, switch

- Sign in starts `aws sso login --sso-session NAME` (or `--profile X` for older-style SSO
  profiles) or `aws login --profile X`. The CLI opens the browser itself; its output is
  streamed to the page so any URL or code is visible. A "use device code" option covers PCs
  where the browser callback is blocked.
- One sign-in job per session at a time, cancellable, stops after 5 minutes.
- Sign out runs `aws logout --profile X` or `aws sso logout`.
- Switching sets the active profile and region in the dashboard header. It applies to the
  runner and resource pages. It does not change the terminal's environment or the config
  files.

### Command runner

- Type `s3 ls` or `aws s3 ls`. The server splits the text into arguments itself and starts
  `aws.exe` directly with no shell, so shell operators such as `|`, `&` and `>` have no
  effect.
- Runs with `AWS_PROFILE`, the chosen region, and the pager turned off. `--output json` is
  added when you did not pick a format.
- Output streams live, with a cancel button, a time limit and a size cap. JSON is shown as a
  collapsible tree; a list of objects can be shown as a sortable table; raw text is always
  available.
- Commands that are not clearly read-only (anything other than `describe`, `list`, `get`,
  `ls`, `head` and similar) ask for confirmation, naming the profile and account they will
  run against.
- Commands that need keyboard input (`aws configure`, `ssm start-session`) are not
  supported; input is closed so they fail straight away instead of hanging.
- History per profile and saved favourites, kept on this PC only.

### Resource views

- Each view is a short definition: CLI command, a JMESPath query, and table columns. All go
  through the same `cli.ts`, so adding a service later is about 20 lines.
- First set, all read-only: EC2 instances, S3 buckets, Lambda functions, RDS instances,
  CloudFormation stacks, CloudWatch alarms.
- When the role lacks permission, the page says so for that service instead of failing.
- Cost Explorer is left out: it charges per request and is often denied to SSO roles.

### Security of the local server

A local page that can run AWS commands must not be reachable by other websites or other PCs.

- Listens on `127.0.0.1` only, default port 4780, configurable.
- A random token is created at each start and passed to the browser in the URL fragment;
  every API call must carry it.
- The `Host` header must be `127.0.0.1` or `localhost` with the right port, and `Origin` is
  checked on every call that changes something. No cross-origin access is enabled.
- Only `aws.exe` is ever started, by its full path found at startup, never through a shell.
- Credential values are never read into responses or logs.

## Build order

1. **Foundation.** `git init`, project scaffold, secure server, config parser, profile list
   page. Result: every profile visible with type, account and region.
2. **Sessions.** Status checks, sign in, sign out, active profile and region selector.
3. **Command runner.** Argument splitting, streaming, output views, confirmation, history.
4. **Resource views.** The definition format and the six first services.
5. **Work readiness.** Search, grouping, pins, colour labels; `npm run bundle` producing one
   server file plus the built frontend, so the work PC needs only Node and no `npm install`;
   README with setup steps for both PCs.

## Verification

- **Unit tests** (`npm test`): config parser and profile typing against fixture files that
  mimic the work setup (SSO sessions, older-style SSO profiles, assume-role chains, access
  keys, `credential_process`); argument splitting; error-text mapping; read-only detection.
- **Fake CLI:** an environment variable points `cli.ts` at a test script that imitates
  `aws` replies, including expired SSO sessions, since real SSO is not available here.
- **Real run on this PC** (`npm start`):
  - `default` appears as AWS login, account 056469778750, `eu-west-1`, valid.
  - Runner: `sts get-caller-identity` and `s3 ls` return results; a `delete` command asks
    for confirmation.
  - Resource pages load for EC2, S3 and Lambda.
  - Sign out then sign in from the page (I will ask before doing this, since it ends the
    current session).
- **Security checks:** a request without the token is refused; a request with a foreign
  `Host` header is refused; the port is not reachable from another device.
- **UI smoke test** in a browser through the Playwright tools.
- **Work PC checklist** (for you to run, as I cannot reach it): all profiles listed and
  grouped by SSO session; one SSO sign-in turns the whole group valid; switching profile
  changes the account shown by `sts get-caller-identity`; proxy and CA settings work.

## Open points

- The SSO path is built from the CLI's documented behaviour and tested with fixtures only
  until it runs on the work PC. Expect a small round of fixes after the first try there.
- The list of six services is my choice; tell me which ones you use most and I will swap them.
