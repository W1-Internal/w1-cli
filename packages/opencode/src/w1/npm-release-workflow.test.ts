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

  test("executes both exact Windows release binaries before publishing", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    const smoke = workflow.indexOf("windows-smoke:")
    const publish = workflow.indexOf("\n  publish:")

    expect(smoke).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(smoke)
    expect(workflow).toContain("needs: [build, windows-smoke]")
    expect(workflow).toContain('"release/npm/w1-cli-windows-x64/bin/w1.exe"')
    expect(workflow).toContain('"release/npm/w1-cli-windows-x64-baseline/bin/w1.exe"')
    expect(workflow).toContain("& $binary --version")
    expect(workflow).toContain("& $binary --help")
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

  test("records checksums as bare filenames so they survive artifact transport", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    // sha256sum stores paths verbatim. Recording "dist/npm-packed/x.tgz" makes the manifest
    // unverifiable from the directory it is downloaded into, which fails the release at the last gate.
    expect(workflow).toContain("( cd dist/npm-packed && sha256sum *.tgz > SHA256SUMS.txt )")
    expect(workflow).not.toContain("sha256sum dist/npm-packed/*.tgz >")
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

  test("waits for registry visibility instead of failing a successful release", async () => {
    const workflow = await readFile(workflowPath, "utf8")
    // A freshly published version is not immediately readable, so asserting once reported a
    // false failure on two real releases that had actually published every package.
    expect(workflow).toContain("never became visible on the registry")
    expect(workflow).toMatch(/for attempt in \$\(seq 1 30\)/)
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
