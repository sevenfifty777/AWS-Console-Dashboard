# AWS-Console-Dashboard

A dashboard for the AWS CLI that runs on your own computer and opens in your browser.
It shows every AWS CLI profile you have, lets you sign in and switch between them, run
CLI commands and browse common resources, without working in a terminal.

It works with whatever your AWS CLI already uses: IAM Identity Center (SSO) profiles,
`aws login`, access keys from `aws configure`, assume-role profiles and
`credential_process`.

## What you need

- AWS CLI version 2, already set up with at least one profile.
- Node.js 20 or newer.

## Start it

```
npm install
npm run build
npm start
```

`npm start` prints a link and opens it in your browser. The link ends in `#token=...`;
that token changes at every start and is what lets your browser tab, and nothing else,
talk to the dashboard. If you open the page without it, paste the link into the box shown.

Options: `npm start -- --port 5000` picks the port (default 4780, or the next free one),
`npm start -- --no-open` does not open the browser.

The dashboard starts in **read-only mode**: nothing in it creates, changes or deletes AWS
resources, and the command runner refuses commands that could.

To run such commands, choose **Write** in the top bar. A popup explains the risk and asks
you to acknowledge it before the mode changes. In write mode the command runner runs any
command, still asking for confirmation before each one that may change something. Choose
**Read-only** to go back at any time. Write mode is not remembered: every start of the
dashboard is read-only again, unless you start it with `npm start -- --allow-changes`.

## Run it on a PC where you cannot run `npm install`

`npm run build` produces a `dist` folder that holds everything:

```
dist/aws-dashboard.mjs    the server, with its dependencies inside
dist/public/              the browser app
```

Copy the `dist` folder to the other PC and run `node aws-dashboard.mjs` inside it.
Only Node.js and the AWS CLI are needed there.

## What it does

### Profiles

Lists the profiles from `~/.aws/config` and `~/.aws/credentials` (or the files named by
`AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`) with type, account, role, region and
session status.

- Profiles that share an SSO session are grouped. **Sign in** runs `aws sso login` once
  for the group; the CLI opens your browser as usual.
- `aws login` profiles sign in with `aws login --profile <name>`.
- Assume-role profiles follow the profile they get their credentials from.
- **Use** makes a profile the active one for the other two pages. This is a dashboard
  setting only: your terminals and config files are not changed.
- Pin profiles to the top, and give them a coloured label: a ready-made one such as
  Production, or a name you type yourself (**Custom name…**, up to 24 characters). The label
  of the active profile is shown on every page, and in the profile list of the top bar.

Status comes from `aws sts get-caller-identity`. For an SSO group one profile is checked
automatically; press **Check** on any other profile to test that one.

### IAM roles

Lists the IAM roles in the account of the active profile, with who is allowed to use each
one. Search by name; roles that only AWS services can use are hidden unless you ask for them.

- **Switch** on a role makes the command runner and the resource lists work as that role.
  For a role in another account, enter its ARN.
- The top bar shows the role in use, with **Leave role** to go back to the profile.
  Changing profile also leaves the role.
- Switching runs `aws sts assume-role` as the active profile, so it works only for roles
  that profile is allowed to assume. The session is named `aws-dashboard-<your user name>`
  in the account's audit trail.

### Command runner

Type any AWS CLI command (`s3 ls`, `ec2 describe-instances ...`). It runs with the active
profile (or the role in use) and region.

- JSON answers are shown as a table or a collapsible tree; the raw text is always available.
  `--output json` is added unless you choose a format.
- Commands that are not clearly read-only (anything other than `describe`, `list`, `get`,
  `ls` and similar) are refused in read-only mode. In write mode they ask for
  confirmation and name the account they will run against. The check goes by the name of
  the command, so treat it as a guard against mistakes, not as a permission system: what a
  profile or role may do is decided by its AWS permissions.
- The command is passed straight to `aws`, not through a shell, so `|`, `>` and `&&` do
  not work. Use `--query` to filter.
- Not supported: commands that need keyboard input (`aws configure`, `ssm start-session`)
  and commands that print secret keys (`configure export-credentials`).
- A command stops after 10 minutes or 10 MB of output.
- History and favourites are kept on your computer only.

### Resources

Read-only lists for EC2 instances, S3 buckets, Lambda functions, RDS instances,
CloudFormation stacks, CloudWatch alarms and Route 53 hosted zones, for the active
profile (or the role in use) and region.

- **All regions** runs each list in every region enabled in the account and adds a Region
  column. Regions that refuse, for example because an organisation policy closes them, are
  named under the list instead of failing it. S3 and Route 53 are the same in every region,
  so the option does not apply to them.
- In the Route 53 list, **Records** on a zone opens the DNS records of that zone.

To add a service, add one entry to `server/src/aws/resources.ts`: the CLI command, a
`--query` that returns flat rows, and the columns to show. A list whose rows open a
second list (like zones and their records) is two entries: the first names the second
in `drill`, and the second says in `param` which CLI option receives the value taken
from the row.

## Security

The dashboard can run AWS commands, so it is built to answer only your own browser tab.

- It listens on `127.0.0.1` only. Other computers cannot reach it.
- Every request needs the token from the start link, and requests coming from other
  websites are refused.
- It starts only the `aws` executable found on your PATH (plus the system tools that open
  the browser and stop a cancelled command).
- It never writes to `~/.aws`. It reads profile settings, and from the sign-in caches only
  the expiry date. The keys of your profiles are not kept, displayed or logged.
- The one exception: after you switch to an IAM role, the dashboard holds that role's
  temporary keys (valid one hour) so that it can run commands as the role. They stay in
  its memory, are never written to disk or sent to the browser, and are gone when it stops.
- Its own settings live in `%APPDATA%\aws-console-dashboard\state.json` on Windows
  (`~/.config/aws-console-dashboard` elsewhere).

Anyone who can use your Windows session can use the dashboard, exactly as they could use
your terminal.

## Development

You only need this section if you change the code. To use the dashboard, `npm start` is enough.

**Live editing.** Run these two commands, each in its own terminal, and leave both running:

```
npm run dev:server     terminal 1: the server on port 4780; restarts when server code changes
npm run dev:web        terminal 2: the browser app on port 5173; reloads when its code changes
```

Then open the link printed by `dev:server` (it points at port 5173 and carries the token).
Without this pair, run `npm run build` and `npm start` again after each change.

After `npm run build`, restart a dashboard that is already running (Ctrl+C, then `npm start`).
Otherwise the browser shows the new page while the old server is still answering, and new
features fail with a message asking you to restart.

**Checks.** These run once and finish by themselves, in any terminal, with no server running:

```
npm test               the automated tests
npm run typecheck      looks for type errors
```

The tests use a stand-in for the AWS CLI (`test/fixtures/fake-aws.mjs`), so they need
neither an AWS account nor a network connection.

```
server/src/aws/    reading the config files, running the CLI, sign-in, command checks
server/src/        HTTP routes, access checks, settings store
web/src/           the browser app (React)
shared/types.ts    data shapes used by both sides
```

## Known limits

- The SSO sign-in path has been tested against sample config files and a stand-in CLI,
  not yet against a real IAM Identity Center setup.
- Signing out of SSO ends every SSO session on the computer; that is how `aws sso logout` works.
- Profiles cannot be created or edited from the dashboard yet. Use the AWS CLI for that.
