export const scenarios = ["home", "calibration", "session", "composer", "history", "review"] as const

export type Scenario = (typeof scenarios)[number]

export type Options = {
  mode: "local" | "partial-snapshot"
  database: string
  output: string
  windowStart: number
  windowEnd: number
  scenarios: Scenario[]
  runs: number
  build: boolean
  diagnostics: boolean
  cpu: boolean
  responseURLs: boolean
  partialSnapshotOut?: string
}

export type Target = {
  label: "p50" | "p95" | "max"
  id: string
  projectID: string
  directory: string
  title: string
  bytes: number
  messages: number
  parts: number
  userTurns: number
}

export type ProbeResult = {
  longTasks: number[]
  animationFrames: {
    duration: number
    blockingDuration: number
    forcedStyleAndLayoutDuration: number
    scripts: {
      function: string
      source: string
      position: number
      invoker: string
      invokerType: string
      duration: number
      forcedStyleAndLayoutDuration: number
    }[]
  }[]
  frameGaps: number[]
  responseText: { url: string; duration: number }[]
}
