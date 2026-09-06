import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pluginPath = process.argv[2];
if (!pluginPath) throw new Error("Usage: smoke-compiled <absolute-plugin-path>");
const { plugin } = await import(pathToFileURL(resolve(pluginPath)).href);

@Module({ providers: [{ provide: "PLUGIN", useValue: plugin }] })
class SmokeModule {}

const sqlite = typeof Bun !== "undefined"
  ? await import("bun:sqlite")
  : await import("node:sqlite");
const Database = "DatabaseSync" in sqlite ? sqlite.DatabaseSync : sqlite.Database;
const directory = await mkdtemp(join(tmpdir(), "relay-framework-proof-"));
const databasePath = join(directory, "proof.sqlite");
const db = new Database(databasePath);
db.exec("create table proof (value text)");
db.prepare("insert into proof values (?)").run(plugin.run());
const app = await NestFactory.createApplicationContext(SmokeModule, { logger: false });
const row = db.prepare("select value from proof").get() as { value: string };
const pluginResult = app.get("PLUGIN").run();
await app.close();
db.close();
const reopened = new Database(databasePath);
const persisted = reopened.prepare("select value from proof").get() as { value: string };
reopened.close();
await rm(directory, { recursive: true, force: true });
console.log(JSON.stringify({ plugin: pluginResult, sqlite: row.value, persisted: persisted.value }));
