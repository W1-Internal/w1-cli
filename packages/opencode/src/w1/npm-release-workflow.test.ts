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
    const macPublish = workflow.indexOf("npm publish release/npm-packed/w1-cli-darwin-arm64.tgz")
    const windowsPublish = workflow.indexOf("npm publish release/npm-packed/w1-cli-windows-x64.tgz")
    const metaPublish = workflow.indexOf("npm publish release/npm-packed/w1-cli.tgz --access public")

    expect(macPublish).toBeGreaterThan(-1)
    expect(windowsPublish).toBeGreaterThan(macPublish)
    expect(metaPublish).toBeGreaterThan(windowsPublish)
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.W1_NPM_TOKEN }}")
    expect(workflow).toContain('npm dist-tag add @w1-lab/cli@"$VERSION" latest')
  })

  test("publishes only the exact tarballs CI packed and checksummed", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const checksum = workflow.indexOf("sha256sum --check SHA256SUMS.txt")
    const firstPublish = workflow.indexOf("npm publish release/npm-packed/")

    expect(checksum).toBeGreaterThan(-1)
    expect(firstPublish).toBeGreaterThan(checksum)
    // Publishing a directory would ship bytes that were never checksummed.
    expect(workflow).not.toContain("npm publish release/npm/")
  })

  test("gates unsafe tarball contents before anything is published", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const gate = workflow.indexOf("Reject unsafe tarball contents")
    const firstPublish = workflow.indexOf("npm publish release/npm-packed/")

    expect(gate).toBeGreaterThan(-1)
    expect(firstPublish).toBeGreaterThan(gate)
    expect(workflow).toContain("Refusing tarball with links")
    expect(workflow).toContain("Refusing tarball with credential or sourcemap content")
  })

  test("every published identity lives inside the owned scope", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    for (const name of [
      "@w1-lab/cli",
      "@w1-lab/cli-darwin-arm64",
      "@w1-lab/cli-darwin-x64",
      "@w1-lab/cli-darwin-x64-baseline",
      "@w1-lab/cli-windows-x64",
    ]) {
      expect(workflow).toContain(name)
    }
    expect(workflow).toContain("Unscoped dependency published")
  })
})
