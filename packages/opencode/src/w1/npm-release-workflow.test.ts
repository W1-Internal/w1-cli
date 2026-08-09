import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"

const workflowPath = path.resolve(import.meta.dir, "../../../../.github/workflows/publish-w1-cli-npm.yml")

describe("W1 npm release workflow", () => {
  test("rehearses without publishing and ships Mac plus Windows from one exact engine", async () => {
    const workflow = await readFile(workflowPath, "utf8")

    expect(workflow).toContain("publish:")
    expect(workflow).toContain("if: ${{ inputs.publish }}")
    expect(workflow).toContain("--target=darwin-arm64")
    expect(workflow).toContain("--target=windows-x64")
    expect(workflow).toContain('test "$(cat "$mac/bin/w1-runtime/BUILD_ID")" = "$HARNESS_REF"')
    expect(workflow).toContain('test "$(cat "$win/bin/w1-runtime/BUILD_ID")" = "$HARNESS_REF"')
  })

  test("publishes every native package before the meta package and promotes the verified release", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const macPublish = workflow.indexOf("npm publish release/npm/w1-cli-darwin-arm64")
    const windowsPublish = workflow.indexOf("npm publish release/npm/w1-cli-windows-x64")
    const metaPublish = workflow.indexOf("npm publish release/npm/w1-cli --access public")

    expect(macPublish).toBeGreaterThan(-1)
    expect(windowsPublish).toBeGreaterThan(macPublish)
    expect(metaPublish).toBeGreaterThan(windowsPublish)
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.W1_NPM_TOKEN }}")
    expect(workflow).toContain("npm dist-tag add w1-cli@\"$VERSION\" latest")
  })
})
