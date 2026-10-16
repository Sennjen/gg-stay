import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JOB_MODES, parseArgs } from '../../../scripts/index/run'

/**
 * The workflow that runs the refresh job, read as the text it is. What it is held to here is what
 * stands between a form somebody fills in and a shell: which words may become the job's mode,
 * which mode a schedule may select, and that no input is ever written into a command line.
 */

const workflow = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/index-refresh.yml', import.meta.url)),
  'utf8',
)
const lines = workflow.split('\n')

/** The modes a `case` arm of the mode step assigns, by what the arm matches on. */
function arms(): { pattern: string; mode: string }[] {
  return lines.flatMap((line) => {
    const arm = /^\s*(\S.*?)\)\s+mode=(\S+)\s+;;\s*$/.exec(line)
    return arm ? [{ pattern: arm[1]!, mode: arm[2]! }] : []
  })
}

describe('the index refresh workflow', () => {
  it('lets a manual run name every mode the job has, and no other word', () => {
    const manual = arms().filter((arm) => arm.mode === '"$INPUT_MODE"')

    expect(manual).toHaveLength(1)
    // The allow-list of the manual arm is the job's own list of modes.
    expect(manual[0]!.pattern.split('|').sort()).toEqual([...JOB_MODES].sort())
    expect(manual[0]!.pattern.split('|')).toContain('resolve')
    for (const mode of manual[0]!.pattern.split('|')) {
      // A budget belongs to resolve and export alone: any other mode given one refuses to start.
      const env = mode === 'resolve' || mode === 'export' ? { INDEX_BUDGET: '1' } : {}
      expect(() => parseArgs([`--mode=${mode}`], env)).not.toThrow()
    }
    // Anything else ends the step.
    expect(workflow).toContain(`*) echo "Unknown mode input" >&2; exit 1 ;;`)
  })

  it('offers resolve in the form, beside the three that are scheduled', () => {
    const options = /options:\n((?:\s+- \S+\n)+)/.exec(workflow)?.[1] ?? ''

    expect(
      options
        .match(/- (\S+)/g)
        ?.map((option) => option.slice(2))
        .sort(),
    ).toEqual([...JOB_MODES].sort())
  })

  it('never selects resolve on a schedule: it is run by hand or not at all', () => {
    const crons = lines.flatMap((line) => /^\s*- cron: '([^']+)'/.exec(line)?.[1] ?? [])
    const scheduled = arms().filter((arm) => arm.pattern.startsWith("'") && arm.pattern !== "''")

    // Every cron has an arm, and every arm names a mode that is not resolve.
    expect(crons).toHaveLength(3)
    expect(scheduled.map((arm) => arm.pattern.slice(1, -1)).sort()).toEqual([...crons].sort())
    expect(scheduled.map((arm) => arm.mode).sort()).toEqual(['full', 'languages', 'prices'])
    // A manual run that names no mode refreshes prices, as it always did.
    expect(arms()).toContainEqual({ pattern: "''", mode: 'prices' })
    expect(arms().filter((arm) => arm.mode === 'resolve')).toEqual([])
    expect(arms().filter((arm) => arm.mode === 'export')).toEqual([])
  })

  it('runs an export in a step of its own, and hands its file out for a week', () => {
    const steps = workflow.split(/\n(?= {6}- )/)
    const exporting = steps.find((step) => step.includes('name: Export the games'))!
    const refreshing = steps.find((step) => step.includes('name: Refresh the index'))!
    const uploading = steps.find((step) => step.includes('name: Upload the export'))!

    expect(exporting).toContain("if: steps.mode.outputs.mode == 'export'")
    // The repository's secrets are four, two of them RAWG's keys; the export's code, not its token, keeps it to reading.
    expect(exporting).toContain('UPSTASH_REDIS_REST_TOKEN: ${{ secrets.UPSTASH_REDIS_REST_TOKEN }}')
    expect(exporting).not.toContain('INDEX_FORCE_UNLOCK')
    expect(exporting).toContain('run: pnpm index:refresh --mode=export')
    // The writing run never runs as an export, and an export is the only run with the upload.
    expect(refreshing).toContain("if: steps.mode.outputs.mode != 'export'")
    expect(uploading).toContain("if: steps.mode.outputs.mode == 'export'")
    expect(uploading).toContain('uses: actions/upload-artifact@v7')
    expect(uploading).toContain('name: games-export-${{ github.run_number }}')
    expect(uploading).toContain('path: games-export/')
    expect(uploading).toContain('retention-days: 7')
  })

  it('hands the numbers of a resolve run to the script through the environment', () => {
    expect(workflow).toContain('INDEX_BUDGET: ${{ inputs.budget }}')
    expect(workflow).toContain('INDEX_FROM_PAGE: ${{ inputs.from_page }}')
    expect(workflow).toContain('INDEX_PAGES: ${{ inputs.pages }}')
    // And declares them as inputs of the form, none of them required: a scheduled run has none.
    for (const input of ['budget', 'from_page', 'pages']) {
      expect(workflow).toMatch(
        new RegExp(`\\n {6}${input}:\\n(?: {8}.*\\n)*? {8}required: false\\n`),
      )
    }
  })

  it('interpolates nothing into a command line: an expression is only ever a whole value', () => {
    const interpolated = lines.filter((line) => line.includes('${{'))

    expect(interpolated.length).toBeGreaterThan(0)
    for (const line of interpolated) {
      // `NAME: ${{ expression }}` under `env:`, and nothing else on the line — or the name of the
      // export's artifact, which is an input of an action and no command.
      expect(line, line).toMatch(
        /^\s+(?:[A-Z][A-Z0-9_]*: \$\{\{ [a-zA-Z0-9_.]+ \}\}|name: games-export-\$\{\{ github\.run_number \}\})$/,
      )
    }
    // The command itself names the mode by the variable the allow-list filled, and no number.
    const commands = lines.filter((line) => /^\s+run: /.test(line))
    expect(commands).toContain('        run: pnpm index:refresh --mode="$MODE"')
    for (const command of commands) expect(command).not.toMatch(/budget|from.page|\$\{\{/i)
  })
})
