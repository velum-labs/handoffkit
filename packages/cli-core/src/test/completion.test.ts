import assert from "node:assert/strict";
import test from "node:test";

import { Command, Option } from "commander";

import {
  completionCandidates,
  completionScript,
  filterCompletionCandidates,
  visibleCommandNames,
  visibleLongFlags,
  walkCompletionTree
} from "../completion.js";

function commandTree(): Command {
  const program = new Command()
    .option("--json")
    .addOption(new Option("--internal-token <token>").hideHelp());
  const sessions = program.command("sessions").alias("session").option("--local");
  sessions.command("remove").alias("rm");
  program.command("help");
  program.command("__complete");
  return program;
}

test("completion helpers expose visible aliases and inherited long flags", () => {
  const program = commandTree();
  const remove = program.commands[0]!.commands[0]!;

  assert.deepEqual(visibleCommandNames(program), ["sessions", "session"]);
  assert.deepEqual(visibleLongFlags(remove), ["--local", "--json"]);
});

test("completion tree walking resolves aliases to canonical paths", () => {
  const state = walkCompletionTree(commandTree(), ["session", "rm", "alpha", "be"]);

  assert.equal(state.command.name(), "remove");
  assert.deepEqual(state.path, ["sessions", "remove"]);
  assert.deepEqual(state.positional, ["alpha"]);
  assert.equal(state.argumentDepth, 1);
  assert.equal(state.currentWord, "be");
});

test("candidate filtering de-duplicates, prefix-filters, and sorts", () => {
  assert.deepEqual(
    filterCompletionCandidates(["beta", "alpha", "alpine", "alpha"], "al"),
    ["alpha", "alpine"]
  );
});

test("completion candidates combine the command tree with dynamic values", () => {
  const program = commandTree();

  assert.deepEqual(completionCandidates(program, ["ses"]), ["session", "sessions"]);
  assert.deepEqual(
    completionCandidates(program, ["session", "rm", "--"]),
    ["--json", "--local"]
  );
  assert.deepEqual(
    completionCandidates(program, ["session", "rm", "a"], (path, depth, positional) => {
      assert.deepEqual(path, ["sessions", "remove"]);
      assert.equal(depth, 0);
      assert.deepEqual(positional, []);
      return ["alpha", "beta"];
    }),
    ["alpha"]
  );
  assert.match(completionScript("bash", "example", program), /sessions\|session\)/);
});
