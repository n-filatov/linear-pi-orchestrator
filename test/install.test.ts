import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installer = join(repositoryRoot, "install.sh");

describe("install.sh", () => {
  it("is valid POSIX shell", async () => {
    await expect(execa("sh", ["-n", installer])).resolves.toMatchObject({ exitCode: 0 });
  });

  it("rejects platforms without a published binary before downloading", async () => {
    const result = await execa("sh", [installer], {
      env: { RELAY_OS: "Linux", RELAY_ARCH: "arm64" },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported Linux architecture: arm64");
  });

  it("downloads, verifies, and installs a release atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-relay-installer-test-"));
    const releaseDirectory = join(directory, "release");
    const installDirectory = join(directory, "bin");
    const asset = "task-relay-linux-x64";
    const fixture = "#!/bin/sh\necho 'Task Relay test version'\n";
    const checksum = createHash("sha256").update(fixture).digest("hex");

    await mkdir(releaseDirectory);
    await writeFile(join(releaseDirectory, asset), fixture);
    await chmod(join(releaseDirectory, asset), 0o755);
    await writeFile(join(releaseDirectory, "checksums.txt"), `${checksum}  ${asset}\n`);

    const result = await execa("sh", [installer], {
      env: {
        INSTALL_DIR: installDirectory,
        RELAY_OS: "Linux",
        RELAY_ARCH: "x86_64",
        RELAY_RELEASE_BASE: pathToFileURL(releaseDirectory).href,
      },
    });

    expect(result.stdout).toContain(`Installed Task Relay to ${join(installDirectory, "relay")}`);
    await expect(execa(join(installDirectory, "relay"), ["--version"])).resolves.toMatchObject({
      stdout: "Task Relay test version",
    });
  });

  it("keeps the release asset names aligned with the build workflow", async () => {
    const [script, workflow] = await Promise.all([
      readFile(installer, "utf8"),
      readFile(join(repositoryRoot, ".github/workflows/build.yml"), "utf8"),
    ]);

    for (const asset of [
      "task-relay-linux-x64",
      "task-relay-macos-arm64",
      "task-relay-macos-x64",
    ]) {
      expect(script).toContain(asset);
      expect(workflow).toContain(`artifact: ${asset}`);
    }
    expect(workflow).toContain("dist/checksums.txt");
  });
});
