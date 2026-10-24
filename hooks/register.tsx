import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Branch, Checks, Pr, SessionBranch, SessionPr, SessionView, Tracked } from '../types'
import {
  age,
  cdTarget,
  commits,
  isPrChange,
  mergeTracked,
  pushedBranch,
  repoFromRemote,
  scanCommand,
  sessionItems,
  sessionLine,
  trackedQuery,
  verdict,
} from './scan'
import type { TrackedData } from './scan'

const PANE = 'old-school-prs'
const TITLE = 'Session PRs'
const SESSION_REFRESH_MS = 2 * 60 * 1000
const ALL_REFRESH_MS = 5 * 60 * 1000
const MAX_TRACKED = 40
const MAX_BRANCHES = 20

const tracked = atom({ plugin: 'old-school-prs', key: 'tracked' } as const, [])
const session = atom({ plugin: 'old-school-prs', key: 'session' } as const, null)
const sessionError = atom({ plugin: 'old-school-prs', key: 'sessionError' } as const, null)
const isLoading = atom({ plugin: 'old-school-prs', key: 'isLoading' } as const, false)
const isAllShown = atom({ plugin: 'old-school-prs', key: 'isAllShown' } as const, false)
const snapshot = atom({ plugin: 'old-school-prs', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'old-school-prs', key: 'error' } as const, null)
const isAllLoading = atom({ plugin: 'old-school-prs', key: 'isAllLoading' } as const, false)

// A session the desktop app starts may not have Homebrew on its PATH.
const GH = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

const PR_QUERY = `query {
  viewer {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft mergeable updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

const BRANCH_QUERY = `query {
  viewer {
    repositories(first: 30, orderBy: { field: PUSHED_AT, direction: DESC },
                 ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]) {
      nodes {
        nameWithOwner isArchived
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: 100) {
          nodes {
            name
            target { ... on Commit { committedDate } }
            associatedPullRequests(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
              nodes { number state }
            }
          }
        }
      }
    }
  }
}`

type PrNode = {
  number: number
  title: string
  url: string
  isDraft: boolean
  mergeable: Pr['mergeable']
  updatedAt: string
  repository: { nameWithOwner: string }
  commits: { nodes: { commit: { statusCheckRollup: { state: Checks } | null } }[] }
}

type RepoNode = {
  nameWithOwner: string
  isArchived: boolean
  defaultBranchRef: { name: string } | null
  refs: {
    nodes: {
      name: string
      target: { committedDate?: string } | null
      associatedPullRequests: { nodes: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED' }[] }
    }[]
  } | null
}

async function run($: EngineInterface, argv: string[]) {
  let reason = 'gh not found'
  for (const bin of argv[0] === 'gh' ? GH : [argv[0]!]) {
    try {
      return await $.process.run([bin, ...argv.slice(1)], { timeoutMs: 60_000 })
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(reason)
}

async function gh($: EngineInterface, args: string[]): Promise<string> {
  const ran = await run($, ['gh', ...args])
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `gh exited with code ${ran.exitCode}`)
  return ran.stdout
}

// gh exits non-zero when a query answers partly (a branch since deleted): the data still counts.
async function graphql<T>($: EngineInterface, query: string): Promise<T> {
  const ran = await run($, ['gh', 'api', 'graphql', '-f', `query=${query}`])
  let out: { data?: T; errors?: { message: string }[] } = {}
  try {
    out = JSON.parse(ran.stdout)
  } catch {
    throw new Error(ran.stderr.trim() || `gh exited with code ${ran.exitCode}`)
  }
  if (!out.data) throw new Error(out.errors?.[0]?.message ?? ran.stderr.trim())
  return out.data
}

async function repoAt($: EngineInterface, dir: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(dir)) return cache.get(dir)!
  let repo: string | null = null
  // A worktree removed since keeps its repository's folder above it.
  for (let path = dir, i = 0; i < 4 && path.length > 1; i++, path = path.replace(/\/[^/]+\/?$/, '')) {
    const ran = await run($, ['git', '-C', path, 'remote', 'get-url', 'origin']).catch(() => null)
    if (ran?.exitCode === 0) {
      repo = repoFromRemote(ran.stdout.trim())
      break
    }
  }
  cache.set(dir, repo)
  return repo
}

async function scanOne(
  $: EngineInterface,
  command: string,
  output: string,
  cwd: string,
  cache: Map<string, string | null>,
): Promise<Tracked[]> {
  let repoOf: string | null = null
  if (pushedBranch(command)) {
    const target = cdTarget(command)
    const dir = !target ? cwd : target.startsWith('/') ? target : target.startsWith('~') ? null : `${cwd}/${target}`
    repoOf = dir ? await repoAt($, dir, cache) : null
  }
  return scanCommand(command, output, repoOf)
}

// Everything the transcript shows the session opened or pushed, and the
// branch its own working copy is on.
async function scanSession($: EngineInterface): Promise<Tracked[]> {
  const cwd = await $.session.cwd()
  const cache = new Map<string, string | null>()
  let found: Tracked[] = []
  for (const message of await $.session.messages()) {
    for (const use of message.toolUses) {
      const command = String(use.input.command ?? '')
      if (use.tool !== 'Bash' || !isPrChange(command)) continue
      found = mergeTracked(found, await scanOne($, command, use.text ?? '', cwd, cache))
    }
  }
  const repo = repoFromRemote((await $.session.repo())?.remote)
  const current = await run($, ['git', '-C', cwd, 'branch', '--show-current']).catch(() => null)
  const branch = current?.exitCode === 0 ? current.stdout.trim() : ''
  if (repo && branch && branch !== 'main' && branch !== 'master') {
    found = mergeTracked(found, [{ repo, branch }])
  }
  return found
}

async function loadSession($: EngineInterface, list: readonly Tracked[]): Promise<SessionView['items']> {
  const recent = list.slice(-MAX_TRACKED)
  if (recent.length === 0) return []
  return sessionItems(recent, await graphql<TrackedData>($, trackedQuery(recent)))
}

async function loadPrs($: EngineInterface): Promise<Pr[]> {
  const data = await graphql<{ viewer: { pullRequests: { nodes: PrNode[] } } }>($, PR_QUERY)
  return data.viewer.pullRequests.nodes.map(node => ({
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    mergeable: node.mergeable,
    checks: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    updatedAt: node.updatedAt,
  }))
}

async function aheadBy($: EngineInterface, branch: Branch): Promise<number | null> {
  try {
    const path = `repos/${branch.repo}/compare/${encodeURI(branch.base)}...${encodeURI(branch.name)}`
    return Number((await gh($, ['api', path, '--jq', '.ahead_by'])).trim())
  } catch {
    return null
  }
}

async function loadBranches($: EngineInterface): Promise<Branch[]> {
  const data = await graphql<{ viewer: { repositories: { nodes: RepoNode[] } } }>($, BRANCH_QUERY)
  const branches: Branch[] = []
  for (const repo of data.viewer.repositories.nodes) {
    const base = repo.defaultBranchRef?.name
    if (repo.isArchived || !base) continue
    for (const ref of repo.refs?.nodes ?? []) {
      const pr = ref.associatedPullRequests.nodes[0]
      if (ref.name === base || pr?.state === 'OPEN') continue
      branches.push({
        repo: repo.nameWithOwner,
        name: ref.name,
        base,
        url: `https://github.com/${repo.nameWithOwner}/tree/${encodeURI(ref.name)}`,
        committedAt: ref.target?.committedDate ?? '',
        lastPr: pr ? { number: pr.number, state: pr.state as 'MERGED' | 'CLOSED' } : null,
        aheadBy: null,
      })
    }
  }
  branches.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
  const shown = branches.slice(0, MAX_BRANCHES)
  const counts = await Promise.all(shown.map(branch => aheadBy($, branch)))
  return shown.map((branch, i) => ({ ...branch, aheadBy: counts[i] ?? null }))
}

let sessionInFlight: Promise<void> | null = null
let allInFlight: Promise<void> | null = null

async function loadSessionView($: EngineInterface): Promise<void> {
  await update($, isLoading, () => true)
  try {
    const items = await loadSession($, await read($, tracked))
    await update($, session, () => ({ items, fetchedAt: Date.now() }))
    await update($, sessionError, () => null)
    $.ui.status(sessionLine(items))
  } catch (err) {
    await update($, sessionError, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, isLoading, () => false)
    sessionInFlight = null
  }
}

function refreshSession($: EngineInterface): Promise<void> {
  sessionInFlight ??= loadSessionView($)
  return sessionInFlight
}

async function loadAll($: EngineInterface): Promise<void> {
  await update($, isAllLoading, () => true)
  try {
    const [prs, branches] = await Promise.all([loadPrs($), loadBranches($)])
    await update($, snapshot, () => ({ prs, branches, fetchedAt: Date.now() }))
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, isAllLoading, () => false)
    allInFlight = null
  }
}

function refreshAll($: EngineInterface): Promise<void> {
  allInFlight ??= loadAll($)
  return allInFlight
}

// v2: v1 lists could hold branches a script only mentioned in its text.
const storeKey = async ($: EngineInterface) => `tracked:v2:${await $.session.id()}`

async function openPane($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(pane => pane.id === PANE)) await $.ui.open({ id: PANE, title: TITLE })
}

async function track($: EngineInterface, found: readonly Tracked[]): Promise<void> {
  const before = await read($, tracked)
  const after = mergeTracked(before, found)
  if (after.length === before.length) return
  await update($, tracked, () => after)
  await $.store.set(await storeKey($), after)
  await openPane($)
}

// What the store kept (it outlives compaction) and what the transcript shows now.
async function start($: EngineInterface): Promise<void> {
  const stored = await $.store.get(await storeKey($))
  const known = Array.isArray(stored) ? (stored as Tracked[]) : []
  const list = mergeTracked(known, await scanSession($))
  await update($, tracked, () => list)
  await $.store.set(await storeKey($), list)
  if (list.length > 0) await openPane($)
  await refreshSession($)
}

function sessionText(view: SessionView | null): string {
  if (!view || view.items.length === 0) return 'This session has no PRs or pushed branches.'
  return view.items
    .map(item =>
      item.kind === 'pr'
        ? `- ${item.repo}#${item.number} ${item.title}: ${verdict(item).label}`
        : `- ${item.repo} ${item.name}: ${verdict(item).label}`,
    )
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: "This session's PRs and branches: what is merged, what is ready to merge, what has a conflict",
    })
    await $.tool.register({
      name: 'show',
      description:
        'Opens the pane with the pull requests and branches this session opened or pushed, and returns each with what it needs: merged, ready to merge, conflict, failing checks.',
    })
    await update($, isLoading, () => false)
    await update($, isAllLoading, () => false)
    $.clock.after(10, () => void start($))
    $.clock.every(SESSION_REFRESH_MS, () => void refreshSession($))
    $.clock.every(ALL_REFRESH_MS, async () => {
      if (await read($, isAllShown)) void refreshAll($)
    })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (isPrChange(e.command)) {
      const cwd = await $.session.cwd()
      await track($, await scanOne($, e.command, ran.text ?? '', cwd, new Map()))
      void refreshSession($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'prs' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refreshSession($)
    const lines = [sessionText(await read($, session))]
    if (!opened.isPlaced) lines.push(`Pane not shown: ${opened.reason}`)

    return { text: lines.join('\n') }
  })

  on('tool.call', { tool: 'mcp__old-school-prs__show' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    await refreshSession($)
    const failed = await read($, sessionError)
    const lines = [
      opened.isPlaced ? 'Pane is shown.' : `Pane is not shown: ${opened.reason}`,
      failed ? `Last refresh failed: ${failed}` : '',
      sessionText(await read($, session)),
    ]

    return { result: lines.filter(Boolean).join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const view = await read($, session)
    const loading = await read($, isLoading)
    const failed = await read($, sessionError)
    const showAll = await read($, isAllShown)
    const all = showAll ? await read($, snapshot) : null
    const allLoading = showAll && (await read($, isAllLoading))
    const allFailed = showAll ? await read($, error) : null
    const now = Date.now()
    const items = view?.items ?? []
    const isMultiRepo = new Set(items.map(item => item.repo)).size > 1
    const prLabel = (pr: SessionPr) => (isMultiRepo ? `${pr.repo.split('/')[1]}#${pr.number}` : `#${pr.number}`)
    const active = items.filter(item => verdict(item).rank < 6)
    const merged = items.filter((item): item is SessionPr => item.kind === 'pr' && item.state === 'MERGED')
    const closed = items.filter((item): item is SessionPr => item.kind === 'pr' && item.state === 'CLOSED')
    const finished = items.filter((item): item is SessionBranch => item.kind === 'branch' && verdict(item).rank >= 6)

    const tone = (item: SessionPr | SessionBranch) => {
      const v = verdict(item)
      return v.tone === 'dim' ? <Text dimColor>{v.label}</Text> : <Text color={v.tone} bold>{v.label}</Text>
    }

    const byRepo = <T extends { repo: string }>(list: T[]): [string, T[]][] => {
      const groups = new Map<string, T[]>()
      for (const item of list) groups.set(item.repo, [...(groups.get(item.repo) ?? []), item])
      return [...groups]
    }

    const checksMark = (pr: Pr) => {
      if (pr.checks === 'SUCCESS') return <Text color="success">✓</Text>
      if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return <Text color="error">✗</Text>
      if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') return <Text color="warning">…</Text>
      return <Text dimColor>·</Text>
    }

    const branchNote = (b: Branch) => {
      const notes: string[] = []
      if (b.aheadBy === 0) notes.push(`all in ${b.base}`)
      else if (b.aheadBy) notes.push(`+${b.aheadBy} ${commits(b.aheadBy)}`)
      if (b.lastPr) notes.push(`PR #${b.lastPr.number} ${b.lastPr.state === 'MERGED' ? 'merged' : 'closed'}`)
      if (b.committedAt) notes.push(age(b.committedAt, now))
      return notes.join(' · ')
    }

    return (
      <Box flexDirection="column" gap={1}>
        {failed && <Text color="error">Could not refresh: {failed}</Text>}
        {!view && !failed && <Text dimColor>Looking for PRs…</Text>}
        {view && items.length === 0 && <Text dimColor>No PRs in this session.</Text>}
        {active.length > 0 && (
          <Box flexDirection="column">
            {active.map(item => (
              <Box
                key={item.kind === 'pr' ? `s-${item.repo}#${item.number}` : `s-${item.repo}@${item.name}`}
                flexDirection="row"
                gap={1}
              >
                <Box flexShrink={0}>{tone(item)}</Box>
                {item.kind === 'pr' ? (
                  <Link href={item.url} label={prLabel(item)} />
                ) : (
                  <Link href={item.url} label={item.name} />
                )}
                {item.kind === 'pr' && (
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">{item.title}</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {(merged.length > 0 || closed.length > 0 || finished.length > 0) && (
          <Box flexDirection="column">
            {merged.length > 0 && (
              <Box key="merged" flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text color="merged">merged</Text>
                {merged.map(pr => (
                  <Link href={pr.url} label={prLabel(pr)} />
                ))}
              </Box>
            )}
            {closed.length > 0 && (
              <Box key="closed" flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>closed</Text>
                {closed.map(pr => (
                  <Link href={pr.url} label={prLabel(pr)} />
                ))}
              </Box>
            )}
            {finished.length > 0 && (
              <Box key="finished" flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>no PR, all in {finished[0]!.base}</Text>
                {finished.map(b => (
                  <Link href={b.url} label={b.name} />
                ))}
              </Box>
            )}
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" plain label={loading ? 'Refreshing…' : 'Refresh'} onPress={() => void refreshSession($)} />
          <Button
            key="toggle-all"
            plain
            label={showAll ? 'Hide all open PRs' : 'All my open PRs'}
            onPress={async () => {
              const next = !(await read($, isAllShown))
              await update($, isAllShown, () => next)
              if (next) void refreshAll($)
            }}
          />
        </Box>
        {showAll && allLoading && !all && <Text dimColor>Loading…</Text>}
        {allFailed && <Text color="error">Could not refresh: {allFailed}</Text>}
        {all && (
          <Box flexDirection="column">
            <Text bold>All open PRs · {all.prs.length}</Text>
            {byRepo(all.prs).map(([repo, prs]) => (
              <Box key={`pr-${repo}`} flexDirection="column" marginTop={1}>
                <Text dimColor>{repo}</Text>
                {prs.map(pr => (
                  <Box key={`pr-${repo}-${pr.number}`} flexDirection="row" gap={1}>
                    {checksMark(pr)}
                    <Link href={pr.url} label={`#${pr.number}`} />
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text wrap="truncate-end">
                        {pr.mergeable === 'CONFLICTING' && <Text color="error">conflict </Text>}
                        {pr.isDraft && <Text dimColor>draft </Text>}
                        {pr.title}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      <Text dimColor>{age(pr.updatedAt, now)}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
        {all && (
          <Box flexDirection="column">
            <Text bold>Branches without an open PR · {all.branches.length}</Text>
            {byRepo(all.branches).map(([repo, branches]) => (
              <Box key={`br-${repo}`} flexDirection="column" marginTop={1}>
                <Text dimColor>{repo}</Text>
                {branches.map(b => (
                  <Box key={`br-${repo}-${b.name}`} flexDirection="row" gap={1}>
                    <Link href={b.url} label={b.name} />
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text dimColor wrap="truncate-end">
                        {branchNote(b)}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
