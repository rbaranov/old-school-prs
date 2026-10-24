import type { SessionBranch, SessionPr, Tracked } from '../types'

const REPO = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
const DEFAULT_BRANCHES = new Set(['main', 'master'])

export function trackedKey(t: Tracked): string {
  return t.number ? `${t.repo}#${t.number}` : `${t.repo}@${t.branch}`
}

export function mergeTracked(old: readonly Tracked[], found: readonly Tracked[]): Tracked[] {
  const seen = new Set(old.map(trackedKey))
  const added = found.filter(t => {
    const key = trackedKey(t)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...old, ...added]
}

export function repoFromRemote(remote: string | null | undefined): string | null {
  const match = remote?.match(new RegExp(`github\\.com[:/](${REPO}?)(?:\\.git)?/?$`))
  return match?.[1]?.replace(/\.git$/, '') ?? null
}

// The directory a command `cd`s into before it pushes, if it says so.
export function cdTarget(command: string): string | null {
  const match = command.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/)
  return match?.[1]?.replace(/^["']|["']$/g, '') ?? null
}

const GIT_PUSH = /^git\s+(?:-C\s+\S+\s+)?push\b/
const PR_CREATE = /^gh\s+pr\s+create\b/
const PR_CHANGE = /^gh\s+pr\s+(?:create|merge|close|ready|reopen)\b|^git\s+(?:-C\s+\S+\s+)?(?:push|merge)\b/

// The commands a shell line runs, each from its start: heredoc bodies and the
// text of a script that merely mentions `git push` are not commands.
export function commandParts(command: string): string[] {
  const code = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '')
  return code
    .split(/\|\||&&|;|\||\n/)
    .map(part => part.trim().replace(/^[({]\s*/, ''))
    .filter(Boolean)
}

export function isPrChange(command: string): boolean {
  return commandParts(command).some(part => PR_CHANGE.test(part))
}

// A command that runs `git push` names its branch after the remote: `-u origin feat/x`.
export function pushedBranch(command: string): string | null {
  for (const part of commandParts(command)) {
    if (!GIT_PUSH.test(part) || /--delete|\s:\S/.test(part)) continue
    const match = part.match(/\bpush\b(?:\s+-{1,2}[\w-]+)*\s+origin\s+(?:HEAD:)?([\w./-]+)/)
    const branch = match?.[1]
    if (branch && !DEFAULT_BRANCHES.has(branch) && branch !== 'HEAD') return branch
  }
  return null
}

// What one Bash call shows the session opened or pushed. `repoOf` names the
// repository a pushed branch belongs to when the output does not say.
export function scanCommand(command: string, output: string, repoOf: string | null): Tracked[] {
  const found: Tracked[] = []
  const parts = commandParts(command)
  if (parts.some(part => PR_CREATE.test(part))) {
    for (const m of output.matchAll(new RegExp(`https://github\\.com/(${REPO})/pull/(\\d+)`, 'g'))) {
      found.push({ repo: m[1]!, number: Number(m[2]) })
    }
  }
  if (parts.some(part => GIT_PUSH.test(part))) {
    for (const m of output.matchAll(new RegExp(`https://github\\.com/(${REPO})/pull/new/(\\S+)`, 'g'))) {
      found.push({ repo: m[1]!, branch: m[2]! })
    }
    const branch = pushedBranch(command)
    const outRepo = repoFromRemote(output.match(/^To (\S+)/m)?.[1])
    const repo = outRepo ?? repoOf
    if (branch && repo) found.push({ repo, branch })
  }
  return mergeTracked([], found)
}

const PR_FIELDS = `number title url state isDraft mergeable mergeStateStatus reviewDecision
  mergedAt closedAt updatedAt headRefName baseRefName
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

type SessionPrNode = {
  number: number
  title: string
  url: string
  state: SessionPr['state']
  isDraft: boolean
  mergeable: SessionPr['mergeable']
  mergeStateStatus: string
  reviewDecision: string | null
  mergedAt: string | null
  closedAt: string | null
  updatedAt: string
  headRefName: string
  baseRefName: string
  commits: { nodes: { commit: { statusCheckRollup: { state: SessionPr['checks'] } | null } }[] }
}

type TrackedNode = {
  pullRequest?: SessionPrNode | null
  pullRequests?: { nodes: SessionPrNode[] }
  ref?: { name: string } | null
  defaultBranchRef?: { name: string; compare: { aheadBy: number } | null } | null
}

export type TrackedData = Record<string, TrackedNode | null>

// One query for all of them: `t<i>` answers the i-th, a PR by number or a branch by name.
export function trackedQuery(list: readonly Tracked[]): string {
  const parts = list.map((t, i) => {
    const [owner, name] = t.repo.split('/')
    const head = `t${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)})`
    if (t.number) return `${head} { pullRequest(number: ${t.number}) { ${PR_FIELDS} } }`
    const branch = JSON.stringify(t.branch)
    return `${head} {
      defaultBranchRef { name compare(headRef: ${branch}) { aheadBy } }
      ref(qualifiedName: ${JSON.stringify(`refs/heads/${t.branch}`)}) { name }
      pullRequests(headRefName: ${branch}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${PR_FIELDS} }
      }
    }`
  })
  return `query {\n${parts.join('\n')}\n}`
}

function toSessionPr(repo: string, node: SessionPrNode): SessionPr {
  return {
    kind: 'pr',
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    mergeable: node.mergeable,
    checks: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    updatedAt: node.updatedAt,
    state: node.state,
    mergeState: node.mergeStateStatus,
    reviewDecision: node.reviewDecision,
    branch: node.headRefName,
    base: node.baseRefName,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
  }
}

// A branch with a PR shows as that PR; a branch deleted with no PR is left out.
export function sessionItems(list: readonly Tracked[], data: TrackedData): (SessionPr | SessionBranch)[] {
  const items = new Map<string, SessionPr | SessionBranch>()
  list.forEach((t, i) => {
    const node = data[`t${i}`]
    if (!node) return
    const pr = t.number ? node.pullRequest : node.pullRequests?.nodes[0]
    if (pr) {
      items.set(`${t.repo}#${pr.number}`, toSessionPr(t.repo, pr))
    } else if (t.branch && node.ref) {
      items.set(trackedKey(t), {
        kind: 'branch',
        repo: t.repo,
        name: t.branch,
        base: node.defaultBranchRef?.name ?? 'main',
        url: `https://github.com/${t.repo}/tree/${encodeURI(t.branch)}`,
        aheadBy: node.defaultBranchRef?.compare?.aheadBy ?? null,
      })
    }
  })
  const when = (item: SessionPr | SessionBranch) =>
    item.kind === 'pr' ? (item.mergedAt ?? item.closedAt ?? item.updatedAt) : ''
  return [...items.values()].sort((a, b) => verdict(a).rank - verdict(b).rank || when(b).localeCompare(when(a)))
}

export type Verdict = {
  label: string
  tone: 'success' | 'error' | 'warning' | 'merged' | 'dim'
  rank: number
}

export function verdict(item: SessionPr | SessionBranch): Verdict {
  if (item.kind === 'branch') {
    if (item.aheadBy === 0) return { label: `no PR, all in ${item.base}`, tone: 'dim', rank: 7 }
    if (item.aheadBy) {
      return { label: `no PR, ${item.aheadBy} ${commits(item.aheadBy)} not in ${item.base}`, tone: 'warning', rank: 3 }
    }
    return { label: 'no PR', tone: 'warning', rank: 3 }
  }
  if (item.state === 'MERGED') return { label: 'merged', tone: 'merged', rank: 6 }
  if (item.state === 'CLOSED') return { label: 'closed without merge', tone: 'dim', rank: 7 }
  if (item.mergeable === 'CONFLICTING') return { label: 'conflict', tone: 'error', rank: 0 }
  if (item.checks === 'FAILURE' || item.checks === 'ERROR') return { label: 'checks failed', tone: 'error', rank: 0 }
  if (item.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes requested', tone: 'error', rank: 0 }
  if (item.isDraft) return { label: 'draft', tone: 'dim', rank: 4 }
  if (item.checks === 'PENDING' || item.checks === 'EXPECTED') return { label: 'checks running', tone: 'warning', rank: 2 }
  if (item.mergeable === 'UNKNOWN') return { label: 'checking for conflicts', tone: 'warning', rank: 2 }
  if (item.mergeState === 'BEHIND') return { label: `behind ${item.base}`, tone: 'warning', rank: 1 }
  if (item.reviewDecision === 'REVIEW_REQUIRED') return { label: 'review required', tone: 'warning', rank: 1 }
  return { label: 'ready to merge', tone: 'success', rank: 1 }
}

export function commits(n: number): string {
  return n === 1 ? 'commit' : 'commits'
}

export function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  return `${Math.round(days / 30)}mo`
}

// The status line names only what still waits for the person; nothing waits, no line.
export function sessionLine(items: readonly (SessionPr | SessionBranch)[]): string | undefined {
  const waiting = items.filter(item => verdict(item).rank < 6)
  if (waiting.length === 0) return undefined
  const name = (item: SessionPr | SessionBranch) => (item.kind === 'pr' ? `#${item.number}` : item.name)
  return `${waiting
    .slice(0, 3)
    .map(item => `${name(item)} ${verdict(item).label}`)
    .join(' · ')}${waiting.length > 3 ? ` · ${waiting.length - 3} more` : ''}`
}
