#!/usr/bin/env node
// git-time-machine — zero-dependency interactive git history browser
// Node 18+ ES modules, no external deps

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const C = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  magenta:  '\x1b[35m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',
  bgBlue:   '\x1b[44m',
  bgBlack:  '\x1b[40m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearScreen: '\x1b[2J\x1b[H',
  clearLine:   '\x1b[2K\r',
  saveCursor:  '\x1b[s',
  restCursor:  '\x1b[u',
};

const color = (c, s) => `${c}${s}${C.reset}`;
const bold  = s => color(C.bold, s);
const dim   = s => color(C.dim, s);

// ─── Git helpers (execFileSync only — no exec/execSync) ──────────────────────
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function gitMust(...args) {
  const result = git(...args);
  if (result === null) {
    console.error(color(C.red, `git ${args.join(' ')} failed`));
    process.exit(1);
  }
  return result;
}

function isGitRepo() {
  return git('rev-parse', '--git-dir') !== null;
}

function getCommits(file = null, search = null, dateFilter = null, limit = 200) {
  const fmt = '%H%x00%aI%x00%an%x00%s%x00%ad%x00%ae';
  const args = ['log', `--format=${fmt}`, '--date=short'];

  if (limit) args.push(`-n`, String(limit));
  if (dateFilter) args.push(`--before=${dateFilter}`);
  if (search) args.push(`--grep=${search}`, '-i');
  if (file) { args.push('--follow', '--', file); }

  const raw = git(...args);
  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\x00');
    return {
      hash:    parts[0] || '',
      date:    parts[1] || '',
      author:  parts[2] || '',
      message: parts[3] || '',
      shortDate: parts[4] || '',
      email:   parts[5] || '',
      shortHash: (parts[0] || '').slice(0, 8),
    };
  }).filter(c => c.hash);
}

function getFileTree(hash) {
  return git('ls-tree', '-r', '--name-only', hash) || '';
}

function getDiff(hash) {
  return git('show', '--stat', '--color=never', `${hash}^..${hash}`) ||
         git('show', '--stat', '--color=never', hash) || '';
}

function getFileDiff(hash, file) {
  return git('show', '--color=never', `${hash}`, '--', file) || '';
}

function getFileAtCommit(hash, file) {
  return git('show', `${hash}:${file}`) || '';
}

function getCurrentBranch() {
  return git('branch', '--show-current') || 'HEAD';
}

function getStashes() {
  const raw = git('stash', 'list');
  if (!raw) return [];
  return raw.split('\n').filter(l => l.includes('gtm-checkpoint'));
}

function stashCheckpoint(label) {
  git('stash', 'push', '-m', `gtm-checkpoint: ${label}`);
}

function isDetachedHead() {
  return git('symbolic-ref', '-q', 'HEAD') === null;
}

// ─── Terminal size ────────────────────────────────────────────────────────────
function termSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows    || 24,
  };
}

// ─── Color a diff line ────────────────────────────────────────────────────────
function colorDiffLine(line) {
  if (line.startsWith('+') && !line.startsWith('+++')) return color(C.green, line);
  if (line.startsWith('-') && !line.startsWith('---')) return color(C.red, line);
  if (line.startsWith('@@'))                            return color(C.cyan, line);
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return color(C.yellow, line);
  }
  return line;
}

// ─── TUI State ────────────────────────────────────────────────────────────────
let tuiActive = false;

function cleanup() {
  if (tuiActive) {
    process.stdout.write(C.showCursor);
    process.stdout.write('\x1b[?1049l'); // restore alt screen
    tuiActive = false;
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// ─── Draw helpers ─────────────────────────────────────────────────────────────
function moveTo(row, col = 0) {
  return `\x1b[${row};${col}H`;
}

function box(title, content, startRow, startCol, width, height) {
  const lines = [];
  const topBorder    = '╔' + '═'.repeat(width - 2) + '╗';
  const bottomBorder = '╚' + '═'.repeat(width - 2) + '╝';
  const titleBar = `╔═ ${bold(title)} ${'═'.repeat(Math.max(0, width - title.length - 5))}╗`;

  lines.push(moveTo(startRow, startCol) + color(C.cyan, titleBar));
  const contentLines = content.split('\n').slice(0, height - 2);
  for (let i = 0; i < height - 2; i++) {
    const text = contentLines[i] || '';
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - 4 - stripped.length);
    lines.push(moveTo(startRow + 1 + i, startCol) + color(C.cyan, '║') + ' ' + text + ' '.repeat(pad) + ' ' + color(C.cyan, '║'));
  }
  lines.push(moveTo(startRow + height - 1, startCol) + color(C.cyan, bottomBorder));
  return lines.join('');
}

function truncate(str, maxLen) {
  const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ─── TUI Browser ─────────────────────────────────────────────────────────────
function runTUI(commits, filePath = null) {
  if (commits.length === 0) {
    console.log(color(C.yellow, 'No commits found.'));
    return;
  }

  const { cols, rows } = termSize();
  let selected = 0;
  let scrollOffset = 0;
  let mode = 'list'; // 'list' | 'preview'
  let previewScroll = 0;
  let previewContent = '';
  let statusMsg = '';

  // Switch to alternate screen
  process.stdout.write('\x1b[?1049h');
  process.stdout.write(C.hideCursor);
  tuiActive = true;

  function render() {
    const { cols, rows } = termSize();
    const listWidth = Math.floor(cols * 0.4);
    const previewWidth = cols - listWidth - 1;
    const contentRows = rows - 4; // header + footer

    let out = C.clearScreen;

    // ── Header ──
    const branch = getCurrentBranch();
    const header = ` ${color(C.bold + C.cyan, '⏱  git-time-machine')}  ${dim(`branch: ${branch}`)}  ${dim(filePath ? `file: ${filePath}` : `${commits.length} commits`)} `;
    out += moveTo(1, 1) + color(C.bgBlack, header.padEnd(cols));

    // ── Commit list ──
    const visibleCount = contentRows;
    const maxScroll = Math.max(0, commits.length - visibleCount);
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + visibleCount) scrollOffset = selected - visibleCount + 1;
    scrollOffset = Math.min(scrollOffset, maxScroll);

    for (let i = 0; i < visibleCount; i++) {
      const idx = i + scrollOffset;
      if (idx >= commits.length) {
        out += moveTo(i + 2, 1) + ' '.repeat(listWidth);
        continue;
      }
      const c = commits[idx];
      const isSelected = idx === selected;
      const marker  = isSelected ? color(C.cyan, '▶ ') : '  ';
      const hash    = color(C.yellow, c.shortHash);
      const date    = color(C.dim, c.shortDate);
      const msg     = c.message;
      const lineRaw = `${marker}${hash} ${date} ${msg}`;
      const lineLen = lineRaw.replace(/\x1b\[[0-9;]*m/g, '').length;
      const padded  = lineLen < listWidth ? lineRaw + ' '.repeat(listWidth - lineLen) : lineRaw.slice(0, listWidth);

      out += moveTo(i + 2, 1);
      if (isSelected) out += `\x1b[7m`; // reverse video
      out += truncate(padded, listWidth);
      if (isSelected) out += C.reset;
    }

    // ── Divider ──
    for (let r = 2; r <= rows - 2; r++) {
      out += moveTo(r, listWidth + 1) + color(C.dim, '│');
    }

    // ── Preview ──
    const previewStartCol = listWidth + 2;
    const c = commits[selected];
    if (!previewContent || mode === 'list') {
      // Lazy-load preview
      const stat = getDiff(c.hash);
      if (filePath) {
        const fc = getFileAtCommit(c.hash, filePath);
        previewContent = fc ? `── File at ${c.shortHash} ──\n${fc}` : '(file not found at this commit)';
      } else {
        const tree = getFileTree(c.hash).split('\n').slice(0, 30).join('\n');
        previewContent = `── Files in tree ──\n${tree}\n\n── Commit diff ──\n${stat}`;
      }
    }
    const previewLines = previewContent.split('\n');
    const maxPreviewScroll = Math.max(0, previewLines.length - contentRows);
    previewScroll = Math.max(0, Math.min(previewScroll, maxPreviewScroll));

    // Preview header
    out += moveTo(2, previewStartCol);
    out += color(C.bold + C.magenta, truncate(` ${c.shortHash} — ${c.message}`, previewWidth));

    for (let i = 0; i < contentRows - 1; i++) {
      const lineIdx = i + previewScroll;
      const line = previewLines[lineIdx] || '';
      out += moveTo(i + 3, previewStartCol);
      out += truncate(colorDiffLine(line), previewWidth);
      // Pad remainder
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
      if (stripped.length < previewWidth) {
        out += ' '.repeat(previewWidth - stripped.length);
      }
    }

    // ── Footer ──
    const footerLeft = dim(` ↑↓ navigate  Enter/p preview  Space restore  / search  q quit`);
    const footerRight = dim(`${selected + 1}/${commits.length} `);
    const fpad = cols - footerLeft.replace(/\x1b\[[0-9;]*m/g, '').length - footerRight.replace(/\x1b\[[0-9;]*m/g, '').length;
    out += moveTo(rows - 1, 1) + color(C.bgBlack, footerLeft + ' '.repeat(Math.max(0, fpad)) + footerRight);

    // ── Status ──
    if (statusMsg) {
      out += moveTo(rows, 1) + color(C.yellow, statusMsg.padEnd(cols).slice(0, cols));
    } else {
      out += moveTo(rows, 1) + ' '.repeat(cols);
    }

    process.stdout.write(out);
  }

  function clearPreview() {
    previewContent = '';
    previewScroll = 0;
  }

  function confirmRestore(c) {
    const branch = getCurrentBranch();
    const isDetached = isDetachedHead();

    process.stdout.write(C.showCursor);
    process.stdout.write('\x1b[?1049l');
    tuiActive = false;

    console.log('\n' + color(C.yellow + C.bold, '⚠  RESTORE CHECKPOINT'));
    console.log(color(C.dim, '─'.repeat(60)));
    console.log(`  Commit : ${color(C.cyan, c.shortHash)} ${c.message}`);
    console.log(`  Date   : ${c.shortDate}`);
    console.log(`  Author : ${c.author}`);
    if (filePath) {
      console.log(`  File   : ${color(C.magenta, filePath)}`);
      console.log('\n  This will restore only this file to the selected commit.');
      console.log('  Your working tree changes to this file will be overwritten.');
    } else {
      console.log('\n  ' + color(C.red + C.bold, 'WARNING: This enters DETACHED HEAD state.'));
      console.log('  Current changes will be stashed with a checkpoint label.');
      console.log(`  Current branch: ${color(C.cyan, branch || 'detached HEAD')}`);
    }
    console.log(color(C.dim, '─'.repeat(60)));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(color(C.yellow, '  Proceed? [y/N] '), answer => {
      rl.close();
      if (answer.toLowerCase() === 'y') {
        if (filePath) {
          const r = spawnSync('git', ['checkout', c.hash, '--', filePath], { stdio: 'inherit' });
          if (r.status === 0) {
            console.log(color(C.green, `\n  Restored ${filePath} to ${c.shortHash}`));
          } else {
            console.log(color(C.red, `\n  Restore failed.`));
          }
        } else {
          stashCheckpoint(`before-restore-to-${c.shortHash}`);
          console.log(color(C.green, `  Checkpoint stashed.`));
          const r = spawnSync('git', ['checkout', c.hash], { stdio: 'inherit' });
          if (r.status === 0) {
            console.log(color(C.green, `\n  Now at ${c.shortHash} (detached HEAD)`));
            console.log(color(C.dim, `  To return: git checkout ${branch || 'main'}`));
          } else {
            console.log(color(C.red, `\n  Checkout failed.`));
          }
        }
      } else {
        console.log(color(C.dim, '  Restore cancelled.'));
        // Re-enter TUI
        process.stdout.write('\x1b[?1049h');
        process.stdout.write(C.hideCursor);
        tuiActive = true;
        render();
        listenKeys();
      }
    });
  }

  function handleSearchInput() {
    process.stdout.write(C.showCursor);
    process.stdout.write(moveTo(termSize().rows, 1) + color(C.yellow, '/ '));

    let query = '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdin.setRawMode(false);

    process.stdout.write('');
    rl.on('line', line => {
      rl.close();
      process.stdin.setRawMode(true);
      process.stdout.write(C.hideCursor);

      const q = (query + line).trim();
      if (q) {
        const filtered = commits.filter(c =>
          c.message.toLowerCase().includes(q.toLowerCase()) ||
          c.author.toLowerCase().includes(q.toLowerCase()) ||
          c.shortHash.startsWith(q)
        );
        statusMsg = filtered.length > 0
          ? `Search "${q}": ${filtered.length} result(s) — press Esc to clear`
          : `No results for "${q}"`;
        if (filtered.length > 0) {
          const idx = commits.indexOf(filtered[0]);
          if (idx >= 0) { selected = idx; clearPreview(); }
        }
      }
      render();
      listenKeys();
    });

    process.stdin.on('data', d => {
      const ch = d.toString();
      if (ch === '\r' || ch === '\n') return; // handled by rl
      query += ch;
    });
  }

  function listenKeys() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function onKey(key) {
      // Arrow up
      if (key === '\x1b[A' || key === 'k') {
        if (selected > 0) { selected--; clearPreview(); statusMsg = ''; render(); }
        return;
      }
      // Arrow down
      if (key === '\x1b[B' || key === 'j') {
        if (selected < commits.length - 1) { selected++; clearPreview(); statusMsg = ''; render(); }
        return;
      }
      // Page up
      if (key === '\x1b[5~') {
        selected = Math.max(0, selected - 10);
        clearPreview(); statusMsg = ''; render();
        return;
      }
      // Page down
      if (key === '\x1b[6~') {
        selected = Math.min(commits.length - 1, selected + 10);
        clearPreview(); statusMsg = ''; render();
        return;
      }
      // Preview scroll up (shift+up or [)
      if (key === '[') { previewScroll = Math.max(0, previewScroll - 3); render(); return; }
      // Preview scroll down (])
      if (key === ']') { previewScroll += 3; render(); return; }
      // Enter or p — show preview detail
      if (key === '\r' || key === 'p') {
        mode = mode === 'preview' ? 'list' : 'preview';
        clearPreview();
        render();
        return;
      }
      // Space — restore
      if (key === ' ') {
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        confirmRestore(commits[selected]);
        return;
      }
      // / — search
      if (key === '/') {
        process.stdin.removeListener('data', onKey);
        handleSearchInput();
        return;
      }
      // Esc — clear status
      if (key === '\x1b') { statusMsg = ''; render(); return; }
      // g — go to top
      if (key === 'g') { selected = 0; clearPreview(); render(); return; }
      // G — go to bottom
      if (key === 'G') { selected = commits.length - 1; clearPreview(); render(); return; }
      // q or ctrl+c — quit
      if (key === 'q' || key === '\x03') {
        process.stdin.removeListener('data', onKey);
        cleanup();
        process.exit(0);
      }
    }

    process.stdin.on('data', onKey);
  }

  render();
  listenKeys();
}

// ─── Sub-commands ─────────────────────────────────────────────────────────────
function cmdCheckpoints() {
  const stashes = getStashes();
  if (stashes.length === 0) {
    console.log(color(C.dim, 'No gtm checkpoints found.'));
    return;
  }
  console.log(bold('git-time-machine checkpoints:'));
  stashes.forEach(s => console.log('  ' + color(C.cyan, s)));
}

function cmdRestore(hash) {
  const commits = getCommits();
  const c = commits.find(c => c.hash.startsWith(hash) || c.shortHash === hash);
  if (!c) {
    console.error(color(C.red, `Commit ${hash} not found in recent history.`));
    process.exit(1);
  }
  const branch = getCurrentBranch();
  console.log(color(C.yellow, `\nRestoring to commit ${c.shortHash}: ${c.message}`));
  console.log(color(C.red, 'WARNING: This enters DETACHED HEAD state.'));
  console.log('Stashing current changes...');
  stashCheckpoint(`before-restore-to-${c.shortHash}`);
  const r = spawnSync('git', ['checkout', c.hash], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(color(C.green, `\nRestored to ${c.shortHash}`));
    console.log(color(C.dim, `To return: git checkout ${branch || 'main'}`));
  } else {
    console.log(color(C.red, 'Restore failed.'));
    process.exit(1);
  }
}

function printHelp() {
  const v = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  console.log(`
${bold(color(C.cyan, 'git-time-machine'))} ${dim(`v${v}`)} — Interactive git history browser

${bold('USAGE')}
  gtm [file]                    Browse all commits (or commits touching <file>)
  gtm --date "2 weeks ago"      Jump to nearest commit before date
  gtm --search "bug fix"        Filter commits by message
  gtm --restore <hash>          Non-interactive restore to commit
  gtm checkpoints               List saved checkpoint stashes

${bold('TUI KEYS')}
  ↑ / k              Navigate up
  ↓ / j              Navigate down
  PgUp / PgDn        Jump 10 commits
  Enter / p          Toggle commit preview
  [ / ]              Scroll preview up/down
  Space              Restore to selected commit
  /                  Search commits
  g / G              Go to top/bottom
  Esc                Clear status
  q / Ctrl+C         Quit

${bold('EXAMPLES')}
  gtm                           Browse all commits
  gtm src/index.js              Browse commits touching src/index.js
  gtm --date "last monday"      Jump to last Monday's state
  gtm --search "hotfix"         Show only hotfix commits
  gtm --restore abc123f         Restore to commit abc123f
  gtm checkpoints               See all gtm stash checkpoints
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
  if (args.includes('--version') || args.includes('-v')) {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(`git-time-machine v${pkg.version}`);
    return;
  }

  if (!isGitRepo()) {
    console.error(color(C.red, 'Not a git repository.'));
    process.exit(1);
  }

  // Sub-command: checkpoints
  if (args[0] === 'checkpoints') { cmdCheckpoints(); return; }

  // Sub-command: --restore <hash>
  const restoreIdx = args.indexOf('--restore');
  if (restoreIdx !== -1) {
    const hash = args[restoreIdx + 1];
    if (!hash) { console.error(color(C.red, '--restore requires a commit hash')); process.exit(1); }
    cmdRestore(hash);
    return;
  }

  // Options
  let dateFilter = null;
  let searchFilter = null;
  let filePath = null;

  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    dateFilter = args[dateIdx + 1];
    if (!dateFilter) { console.error(color(C.red, '--date requires a value')); process.exit(1); }
  }

  const searchIdx = args.indexOf('--search');
  if (searchIdx !== -1) {
    searchFilter = args[searchIdx + 1];
    if (!searchFilter) { console.error(color(C.red, '--search requires a value')); process.exit(1); }
  }

  // Positional: file path
  const positional = args.filter(a => !a.startsWith('--') && a !== dateFilter && a !== searchFilter);
  if (positional.length > 0) {
    filePath = positional[0];
    if (!fs.existsSync(filePath)) {
      console.error(color(C.red, `File not found: ${filePath}`));
      process.exit(1);
    }
  }

  // Load commits
  process.stdout.write(color(C.dim, 'Loading commits…\r'));
  const commits = getCommits(filePath, searchFilter, dateFilter);

  if (commits.length === 0) {
    console.log(color(C.yellow, 'No commits found matching your criteria.'));
    return;
  }

  // If --date, just jump to nearest and confirm
  if (dateFilter && !process.stdout.isTTY) {
    const c = commits[0];
    console.log(`Nearest commit before "${dateFilter}": ${c.shortHash} (${c.shortDate}) — ${c.message}`);
    return;
  }

  // Check TTY for TUI
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-interactive: just print commits
    commits.forEach(c => {
      console.log(`${color(C.yellow, c.shortHash)}  ${color(C.dim, c.shortDate)}  ${color(C.cyan, c.author.padEnd(20).slice(0, 20))}  ${c.message}`);
    });
    return;
  }

  runTUI(commits, filePath);
}

main().catch(e => {
  cleanup();
  console.error(color(C.red, `Error: ${e.message}`));
  process.exit(1);
});
