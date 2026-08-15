import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRelayProgram } from "../src/cli/program.js";
import { checkRelayUpdate, updateRelay, type RelayUpdateOptions } from "../src/updater.js";

const asset = "task-relay-linux-x64";

describe("Relay self-update", () => {
  it("checks the release digest and atomically installs a verified binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-relay-updater-"));
    const executablePath = join(directory, "relay");
    const oldBinary = "old relay binary";
    const newBinary = "#!/bin/sh\necho 0.2.0\n";
    await writeFile(executablePath, oldBinary);

    const options = fixtureOptions(executablePath, newBinary);
    await expect(checkRelayUpdate(options)).resolves.toMatchObject({
      asset,
      version: "latest",
      updateAvailable: true,
      currentChecksum: digest(oldBinary),
      expectedChecksum: digest(newBinary),
    });

    let smokeTested = "";
    const updated = await updateRelay({
      ...options,
      smokeTest: async (candidate) => { smokeTested = await readFile(candidate, "utf8"); },
    });

    expect(updated.updateAvailable).toBe(false);
    expect(smokeTested).toBe(newBinary);
    await expect(readFile(executablePath, "utf8")).resolves.toBe(newBinary);
    await expect(checkRelayUpdate(options)).resolves.toMatchObject({ updateAvailable: false });
  });

  it("leaves the current executable untouched when verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-relay-updater-bad-"));
    const executablePath = join(directory, "relay");
    const oldBinary = "working relay binary";
    await writeFile(executablePath, oldBinary);
    const expected = "expected release";
    const downloaded = "tampered release";
    const options = fixtureOptions(executablePath, downloaded, digest(expected));

    await expect(updateRelay(options)).rejects.toThrow(/checksum verification failed/i);
    await expect(readFile(executablePath, "utf8")).resolves.toBe(oldBinary);
  });

  it("rejects unsafe release tags before making a request", async () => {
    let requested = false;
    await expect(checkRelayUpdate({
      version: "../../main",
      executablePath: "/unused",
      fetch: async () => { requested = true; return new Response(); },
    })).rejects.toThrow(/invalid release version/i);
    expect(requested).toBe(false);
  });

  it("exposes update without requiring a repository configuration", async () => {
    const stdout = new PassThrough();
    const output: string[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    let received: { check?: boolean; version?: string } | undefined;
    const program = createRelayProgram({
      stdout: stdout as unknown as NodeJS.WriteStream,
      handlers: {
        update: async (options) => {
          received = options;
          return "Update available";
        },
      },
      cwd: () => "/a/directory/without/config",
    });

    await program.parseAsync(["node", "relay", "update", "v0.2.0", "--check"]);

    expect(received).toEqual({ check: true, version: "v0.2.0" });
    expect(output.join("")).toContain("Update available");
  });
});

function fixtureOptions(executablePath: string, binary: string, checksum = digest(binary)): RelayUpdateOptions {
  return {
    executablePath,
    releaseBaseUrl: "https://relay.test/latest",
    platform: "linux",
    architecture: "x64",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/checksums.txt")) return new Response(`${checksum}  ${asset}\n`, { status: 200 });
      if (url.endsWith(`/${asset}`)) return new Response(binary, { status: 200 });
      return new Response("not found", { status: 404 });
    },
    smokeTest: async () => {},
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
