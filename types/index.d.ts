export type Checks = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null

export type Pr = {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  checks: Checks
  updatedAt: string
}

export type Branch = {
  repo: string
  name: string
  base: string
  url: string
  committedAt: string
  lastPr: { number: number; state: 'MERGED' | 'CLOSED' } | null
  aheadBy: number | null
}

export type Snapshot = { prs: Pr[]; branches: Branch[]; fetchedAt: number }

// What the session pushed or opened: a PR by number, or a branch by name.
export type Tracked = { repo: string; number?: number; branch?: string }

export type SessionPr = Pr & {
  kind: 'pr'
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergeState: string
  reviewDecision: string | null
  branch: string
  base: string
  mergedAt: string | null
  closedAt: string | null
}

export type SessionBranch = {
  kind: 'branch'
  repo: string
  name: string
  base: string
  url: string
  aheadBy: number | null
}

export type SessionView = { items: (SessionPr | SessionBranch)[]; fetchedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'old-school-prs': {
      tracked: Tracked[]
      session: SessionView | null
      sessionError: string | null
      isLoading: boolean
      isAllShown: boolean
      snapshot: Snapshot | null
      error: string | null
      isAllLoading: boolean
    }
  }
}
