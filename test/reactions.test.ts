import { describe, expect, it } from "vitest";

import { parseReaction, REACTIONS, roomAllows, socketAllows } from "../src/room/reactions";
import { applyEvent, emptyBoard, type BoardEvent } from "../src/ui/board";

const agents = ["ponder", "zippy"];

describe("spectator reactions", () => {
  it("W1: only a listed emoji passes, with the agent kept only when it races here", () => {
    expect(parseReaction(JSON.stringify({ kind: "react", emoji: "🔥", agent: "zippy" }), agents)).toEqual({ emoji: "🔥", agent: "zippy" });
    expect(parseReaction(JSON.stringify({ kind: "react", emoji: "👏" }), agents)).toEqual({ emoji: "👏" });
    // A pick that is not racing, or not an id, is dropped, not echoed.
    expect(parseReaction(JSON.stringify({ kind: "react", emoji: "👏", agent: "Zippy" }), agents)).toEqual({ emoji: "👏" });
    expect(parseReaction(JSON.stringify({ kind: "react", emoji: "👏", agent: "<b>x</b>" }), agents)).toEqual({ emoji: "👏" });
    for (const bad of [JSON.stringify({ kind: "react", emoji: "🍕" }), JSON.stringify({ kind: "react", emoji: "🔥🔥" }), JSON.stringify({ kind: "claim", emoji: "🔥" }), "🔥", "[]", "null", 42, new ArrayBuffer(2), JSON.stringify({ kind: "react", emoji: "🔥", pad: "x".repeat(300) })]) {
      expect(parseReaction(bad, agents)).toBeUndefined();
    }
    expect(REACTIONS).toHaveLength(6);
  });

  it("W2: a socket reacts once a second, and the room relays at most ten a second", () => {
    expect(socketAllows(undefined, 5_000)).toBe(true);
    expect(socketAllows(5_000, 5_400)).toBe(false);
    expect(socketAllows(5_000, 6_000)).toBe(true);
    let window = roomAllows(undefined, 10_000);
    for (let i = 1; i < 10; i++) window = roomAllows(window, 10_000 + i * 50);
    expect(window?.count).toBe(10);
    expect(roomAllows(window, 10_900)).toBeUndefined();
    // A new second starts a new count.
    expect(roomAllows(window, 11_000)?.count).toBe(1);
  });

  it("W3: the board ignores watchers and reactions: they are not part of the race", () => {
    const board = emptyBoard("t-0123abcd");
    const watchers = { kind: "watchers", taskId: "t-0123abcd", n: 3 } as unknown as BoardEvent;
    const reaction = { kind: "reaction", taskId: "t-0123abcd", emoji: "🔥", agent: "ponder" } as unknown as BoardEvent;
    expect(applyEvent(board, watchers, 1)).toBe(board);
    expect(applyEvent(board, reaction, 1)).toBe(board);
  });
});
