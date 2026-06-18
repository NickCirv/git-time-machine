<div align="center">

# git-time-machine

**Browse your git history in a TUI and safely restore any commit — with preview, diff, and automatic stash checkpoints.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/git-time-machine
```

Or install globally:

```bash
npm install -g github:NickCirv/git-time-machine
```

## Usage

```bash
gtm                            # Browse all commits in an interactive TUI
gtm src/index.js               # Browse only commits that touched a specific file
gtm --date "2 weeks ago"       # Jump to nearest commit before a date
gtm --search "bug fix"         # Filter commits by message
gtm --restore abc123f          # Non-interactive restore to a specific commit
gtm checkpoints                # List all stash checkpoints created by gtm
```

| Flag | Description |
|------|-------------|
| `[file]` | Browse commits touching this file only |
| `--date <value>` | Jump to nearest commit before the given date string |
| `--search <term>` | Filter commit list by message (case-insensitive) |
| `--restore <hash>` | Restore non-interactively to a commit hash |

**TUI keys:** `↑`/`↓`/`j`/`k` navigate · `Enter`/`p` toggle preview · `[`/`]` scroll preview · `Space` restore · `/` search · `g`/`G` top/bottom · `q` quit

## What it does

git-time-machine opens a split-pane TUI showing your commit history on the left and a live diff/file-tree preview on the right. Press `Space` on any commit to restore your repo to that point — it always stashes your current work first with a `gtm-checkpoint` label so nothing is lost. File-scoped restores (`gtm <file>`) only touch that single file, keeping the rest of your working tree untouched.

---

<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
