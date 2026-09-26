import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMAND_GUIDE, RECEIPT_TYPE_GUIDE } from "../../app/shared/guide";
import { parseBotMessage, type BotCommand } from "../../app/shared/parse";
import { RECEIPT_TYPES } from "../../app/shared/types";

const TODAY = "2026-09-25";

const commands = COMMAND_GUIDE.flatMap((group) => group.commands);

describe("COMMAND_GUIDE", () => {
  it("only shows messages that address the bot", () => {
    for (const command of commands) {
      assert.match(command.text, /^@receipts\b/, command.text);
    }
  });

  it("parses every example as the command it demonstrates", () => {
    for (const command of commands) {
      const parsed = parseBotMessage(command.text, TODAY, { isReply: command.reply });
      assert.equal(parsed.kind, command.kind, `${command.text} parsed as ${JSON.stringify(parsed)}`);
    }
  });

  it("never teaches a message the bot rejects or ignores", () => {
    for (const command of commands) {
      assert.notEqual(command.kind, "invalid", command.text);
      assert.notEqual(command.kind, "none", command.text);
    }
  });

  it("covers every chat command", () => {
    const shown = new Set(commands.map((command) => command.kind));
    const all: BotCommand["kind"][] = [
      "help",
      "upcoming",
      "list",
      "mine",
      "join",
      "setup",
      "lfg",
      "show",
      "cancel",
      "settle",
      "accept",
      "reject",
      "nominations",
      "rename",
      "create",
      "capture",
      "exposed",
      "toldYouSo"
    ];
    for (const kind of all) {
      assert.ok(shown.has(kind), `no example for "${kind}"`);
    }
  });

  it("shows how to capture a message by replying to it", () => {
    assert.ok(commands.some((command) => command.reply && command.kind === "capture"));
  });
});

describe("RECEIPT_TYPE_GUIDE", () => {
  it("describes every receipt type once", () => {
    assert.deepEqual(RECEIPT_TYPE_GUIDE.map((entry) => entry.type).sort(), [...RECEIPT_TYPES].sort());
  });

  it("logs each example as its type, tagged only when the guide shows a tag", () => {
    for (const entry of RECEIPT_TYPE_GUIDE) {
      const parsed = parseBotMessage(entry.example, TODAY);
      assert.equal(parsed.kind, "create", `${entry.example} parsed as ${JSON.stringify(parsed)}`);
      if (parsed.kind !== "create") continue;
      assert.equal(parsed.draft.type, entry.type, entry.example);
      assert.equal(parsed.draft.typeExplicit, entry.tag !== null, entry.example);
    }
  });

  it("uses the shown tag in each tagged example", () => {
    for (const entry of RECEIPT_TYPE_GUIDE) {
      if (entry.tag === null) continue;
      assert.match(entry.tag, /^#[a-z]+$/);
      assert.ok(entry.example.includes(`${entry.tag} `), `${entry.example} should use ${entry.tag}`);
    }
  });
});
