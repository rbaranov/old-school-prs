import { expect, mock, test } from 'claude-code/testing'

import { pushedBranch, scanCommand, sessionLine, verdict } from '../hooks/scan'
import type { SessionPr } from '../types'

const PANE = {
  plugin: 'old-school-prs',
  component: 'Pane',
  requestId: 'old-school-prs',
  props: {
    title: 'Session PRs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REPO = 'octo-org/example-app'

// Shaped like a real session's command: push and PR in one line, remote lines kept.
const PUSH_AND_CREATE = {
  command:
    "git push -q -u origin feat/search-filters 2>&1 | tail -2; gh pr create --title 'Search filters' --body-file pr.md",
  output: `remote:      https://github.com/${REPO}/pull/new/feat/search-filters\nremote: \nhttps://github.com/${REPO}/pull/69`,
}

test('a push and a PR in one command are both found', () => {
  expect(scanCommand(PUSH_AND_CREATE.command, PUSH_AND_CREATE.output, null)).toEqual([
    { repo: REPO, number: 69 },
    { repo: REPO, branch: 'feat/search-filters' },
  ])
})

test('a push whose output names no repository takes the folder it ran in', () => {
  const command = 'cd /repo/.worktrees/billing && git push -q -u origin feat/billing 2>&1 | grep -v "^remote:"'
  expect(pushedBranch(command)).toBe('feat/billing')
  expect(scanCommand(command, '', REPO)).toEqual([{ repo: REPO, branch: 'feat/billing' }])
  expect(pushedBranch('git push origin --delete feat/old')).toBeNull()
  expect(pushedBranch('git push origin main')).toBeNull()
})

test("a PR URL outside gh pr create is not the session's", () => {
  expect(scanCommand('gh pr view 12', `https://github.com/${REPO}/pull/12`, REPO)).toEqual([])
})

test('a script that only mentions git push in its text pushes nothing', () => {
  const command = `python3 - <<'EOF'\nif re.search(r"gh pr (create|merge)|git push", cmd): print(cmd)\nEOF`
  const output = `remote: https://github.com/${REPO}/pull/new/feat/x\nhttps://github.com/${REPO}/pull/69`
  expect(scanCommand(command, output, REPO)).toEqual([])
  expect(scanCommand(`grep -n "git push" notes.md`, output, REPO)).toEqual([])
})

test('a PR body written by a heredoc between push and create does not hide them', () => {
  const command = [
    'git push -q -u origin feat/search 2>&1 | tail -2; cat > pr.md <<\'EOF\'',
    'Body that mentions git push and gh pr create.',
    'EOF',
    'gh pr create --body-file pr.md',
  ].join('\n')
  expect(scanCommand(command, `https://github.com/${REPO}/pull/69`, REPO)).toEqual([
    { repo: REPO, number: 69 },
    { repo: REPO, branch: 'feat/search' },
  ])
})

const pr = (over: Partial<SessionPr>): SessionPr => ({
  kind: 'pr',
  repo: REPO,
  number: 77,
  title: 'Export to CSV',
  url: `https://github.com/${REPO}/pull/77`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  checks: 'SUCCESS',
  updatedAt: '2026-10-24T05:00:00Z',
  state: 'OPEN',
  mergeState: 'CLEAN',
  reviewDecision: null,
  branch: 'feat/export',
  base: 'main',
  mergedAt: null,
  closedAt: null,
  ...over,
})

test('each PR says what it needs', () => {
  expect(verdict(pr({})).label).toBe('ready to merge')
  expect(verdict(pr({ mergeable: 'CONFLICTING' })).label).toBe('conflict')
  expect(verdict(pr({ checks: 'FAILURE' })).label).toBe('checks failed')
  expect(verdict(pr({ checks: 'PENDING' })).label).toBe('checks running')
  expect(verdict(pr({ state: 'MERGED' })).label).toBe('merged')
  expect(sessionLine([pr({}), pr({ number: 69, state: 'MERGED' })])).toBe('#77 ready to merge')
  expect(sessionLine([pr({ state: 'MERGED' })])).toBeUndefined()
  expect(sessionLine([])).toBeUndefined()
})

const PR_NODE = {
  number: 77,
  title: 'Export to CSV',
  url: `https://github.com/${REPO}/pull/77`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  reviewDecision: null,
  mergedAt: null,
  closedAt: null,
  updatedAt: '2026-10-24T05:00:00Z',
  headRefName: 'feat/export',
  baseRefName: 'main',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
}

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('the pane shows the PR the session opened and what it needs', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-24T08:00:00Z') })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'prs' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__old-school-prs__show' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: null }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'u1',
            tool: 'Bash',
            input: { command: 'git push -u origin feat/export && gh pr create --fill' },
            text: `https://github.com/${REPO}/pull/77`,
          },
        ],
      },
    ],
  }))
  on('process.run', (_, e) => {
    if (e.argv.join(' ').includes('pullRequest(number: 77)')) {
      return run(JSON.stringify({ data: { t0: { pullRequest: PR_NODE } } }))
    }
    return run('', e.argv[0] === 'git' ? 128 : 1)
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.advance(20)
  const ran = await $.command.run({ command: 'prs', args: '' })
  expect(JSON.stringify(ran)).toContain('conflict')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /conflict/ }))?.text).toBe('conflict')
    expect((await ui.find({ type: 'Text', text: /Export to CSV/ }))?.text).toBe('Export to CSV')
    await ui.unmount()
  }
})
