#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function sendGhostWriterEvent(activity, options = {}) {
  const endpoint = clean(options.endpoint ?? process.env.GHOSTWRITER_ENDPOINT);
  const projectId = clean(options.projectId ?? process.env.GHOSTWRITER_PROJECT_ID);
  const secret = clean(options.secret ?? process.env.GHOSTWRITER_INGEST_SECRET);
  const projectOrigin = normalizeProjectOrigin(options.projectOrigin ?? process.env.GHOSTWRITER_PROJECT_ORIGIN);

  if (!endpoint) throw new Error("GHOSTWRITER_ENDPOINT is required");
  if (!projectId) throw new Error("GHOSTWRITER_PROJECT_ID is required");
  if (!secret) throw new Error("GHOSTWRITER_INGEST_SECRET is required");
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) throw new Error("Bridge activity must be a JSON object");
  if (!clean(activity.type)) throw new Error("Bridge activity requires a type");

  const contentEligible = activity.contentEligible ?? defaultContentEligibility(activity.type);
  const payload = {
    ...(activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload) ? activity.payload : {})
  };
  if (projectOrigin && payload.projectOrigin === undefined) payload.projectOrigin = projectOrigin;

  const event = {
    ...activity,
    projectId,
    source: clean(activity.source) || "project-bridge",
    occurredAt: activity.occurredAt ?? new Date().toISOString(),
    privacy: activity.privacy ?? (contentEligible ? "content_eligible" : "internal"),
    contentEligible,
    payload
  };

  const raw = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GhostWriter-Signature": `sha256=${signature}`
    },
    body: raw
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Ghost Writer rejected bridge event (${response.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export async function bootstrapExistingProject(options = {}) {
  const configuredOrigin = normalizeProjectOrigin(options.projectOrigin ?? process.env.GHOSTWRITER_PROJECT_ORIGIN);
  if (configuredOrigin && configuredOrigin !== "existing") {
    throw new Error("Existing-project bootstrap requires GHOSTWRITER_PROJECT_ORIGIN=existing");
  }

  const cwd = options.cwd ?? process.cwd();
  const snapshot = collectRepositorySnapshot(cwd);
  const recentWork = snapshot.recentCommits.map((commit) => commit.message).filter(Boolean).slice(0, 6);
  const context = [
    snapshot.description ? `Project description: ${snapshot.description}` : "",
    recentWork.length ? `Recent repository work includes: ${recentWork.join("; ")}` : ""
  ].filter(Boolean).join(" ");

  return sendGhostWriterEvent({
    source: "project-bridge-bootstrap",
    sourceEventId: `existing-snapshot:${snapshot.head || "unknown"}`,
    type: "project.snapshot",
    truthState: "in_progress",
    privacy: "content_eligible",
    contentEligible: true,
    title: "Existing project introduction snapshot",
    summary: context || "Existing project repository snapshot imported for an introductory project story.",
    sourceReference: snapshot.remote || undefined,
    payload: {
      projectOrigin: "existing",
      retrospective: true,
      bootstrap: true,
      branch: snapshot.branch,
      head: snapshot.head,
      description: snapshot.description,
      recentCommits: snapshot.recentCommits
    }
  }, { ...options, projectOrigin: "existing" });
}

export function collectRepositorySnapshot(cwd = process.cwd()) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const remote = git(cwd, ["config", "--get", "remote.origin.url"], true);
  const log = git(cwd, ["log", "-n", "15", "--date=iso-strict", "--pretty=format:%H%x1f%ad%x1f%s"], true);
  const recentCommits = log
    ? log.split("\n").filter(Boolean).map((line) => {
        const [sha = "", occurredAt = "", ...messageParts] = line.split("\x1f");
        return { sha, occurredAt, message: messageParts.join("\x1f").trim() };
      })
    : [];

  return {
    branch,
    head,
    remote,
    description: repositoryDescription(cwd),
    recentCommits
  };
}

function repositoryDescription(cwd) {
  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
      if (typeof parsed.description === "string" && parsed.description.trim()) return parsed.description.trim().slice(0, 600);
    } catch {
      // Fall through to README context.
    }
  }

  for (const name of ["README.md", "README.MD", "readme.md", "README"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const paragraphs = text
      .replace(/```[\s\S]*?```/g, " ")
      .split(/\n\s*\n/)
      .map((value) => value.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
      .filter((value) => value && !/^!\[/.test(value));
    const first = paragraphs.find((value) => value.length >= 30);
    if (first) return first.slice(0, 600);
  }
  return "";
}

function git(cwd, args, optional = false) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return "";
    throw new Error(`Existing-project bootstrap needs a Git repository: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultContentEligibility(type) {
  const value = String(type);
  return [
    "project.started",
    "project.snapshot",
    "git.commit",
    "git.merge",
    "test.passed",
    "build.completed",
    "deployment.completed",
    "milestone.completed",
    "decision.made"
  ].includes(value);
}

function normalizeProjectOrigin(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return "";
  if (normalized === "new" || normalized === "existing") return normalized;
  throw new Error("GHOSTWRITER_PROJECT_ORIGIN must be either 'new' or 'existing'");
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  if (process.argv.includes("--bootstrap-existing")) {
    const result = await bootstrapExistingProject();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const inline = process.argv.slice(2).join(" ").trim();
  const raw = inline || await readStdin();
  if (!raw) throw new Error("Pass one JSON activity object as an argument/stdin, or use --bootstrap-existing");
  const parsed = JSON.parse(raw);
  const result = await sendGhostWriterEvent(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
