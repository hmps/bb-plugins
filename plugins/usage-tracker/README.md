<p align="center">
  <img src="./assets/icon.svg" width="64" height="64" alt="Usage Tracker icon" />
</p>

<h1 align="center">Usage Tracker for BB</h1>

<p align="center">
  Codex and Claude Code limits in BB's native sidebar disclosure.
</p>

> Fork of [MateoCerquetella/bb-plugins](https://github.com/MateoCerquetella/bb-plugins) `usage-tracker` (MIT) with
> model-scoped quota rows, Codex reset-credit counts, and pace signals for each
> reported usage window.

Usage Tracker adds one icon beside BB's existing sidebar utility icons. Select
it to open a native-style card with Claude Code and Codex usage details. It
does not add a navigation item or a separate plugin page.

## Features

- Shows Codex and Claude Code subscription usage in BB's sidebar footer.
- Lets you show or hide Codex and Claude Code independently.
- Shows only the windows each provider reports. Codex currently reports its
  weekly limit. Claude Code can report its current session, weekly limit, and
  Fable limit.
- Shows how many full Codex usage resets are available.
- Projects each window forward to its reset time and marks it on track,
  watch, or at risk.
- Shows expected usage at reset beside current usage.
- Includes reset timing and provider session status in the disclosure.
- Refreshes automatically every five minutes while the disclosure is open.
- Provides a manual refresh button for both providers.
- Preserves last-known limit windows through temporary errors, expired
  sessions, and rate limits.
- Uses BB's managed sidebar footer, including its compact icon and disclosure
  behavior.

## Install

Usage Tracker requires BB 0.38 or newer. Install from the `hmps` marketplace:

```sh
bb marketplace add git:https://github.com/hmps/bb-plugins.git@main
bb plugin install usage-tracker@hmps
```

The icon appears in the bottom of the sidebar as soon as the plugin loads.
Both providers are enabled by default. Change them independently under
**Settings → Plugins → Usage Tracker**.

The provider CLIs must be installed and signed in for BB to report their usage:

```sh
codex login
claude
```

If a CLI is missing, signed out, or expired, open that provider in the card
to see the recovery instruction reported by BB.

## Use

The sidebar stays compact until you need the details:

- Select the chart icon to open the usage card.
- Select the Claude Code or Codex tab.
- Review each reported usage window and its reset time.
- Review the available full-reset count in the Codex card.
- Read current and expected usage on the same line, for example
  `12% (103%)`. The value in parentheses is the expected usage at reset.
  The bar and values turn amber or red when the window needs attention.
- Use the collapse button or BB's standard disclosure behavior to close it.
- Select the refresh icon to fetch both providers immediately.

Usage Tracker refreshes when you open the card. It then refreshes every five
minutes while the card remains open.

## Update or remove

Check for updates and install the latest compatible release with BB:

```sh
bb plugin outdated
bb plugin update usage-tracker
```

Remove it with:

```sh
bb plugin remove usage-tracker
```

## Data and privacy

The plugin reads BB's local `system.usageLimits` data. It also calls the local
Codex app server's read-only `account/rateLimits/read` method for the available
reset-credit count. It never redeems a reset and does not ask for or store
provider credentials. Its only persistent browser data is the last successful
usage snapshot in local storage, used to keep useful values visible during a
temporary provider or network failure.

Usage Tracker runs in BB's managed plugin UI. Install plugins only from sources
you trust.

## Develop

```sh
cd plugins/usage-tracker
npm install
npm run check
```

## Links

- [Upstream source](https://github.com/MateoCerquetella/bb-plugins)
- [MIT license](./LICENSE)
