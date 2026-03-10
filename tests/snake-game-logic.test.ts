import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type SnakeApi = {
  createApplePosition: (gridSize: number, snake: { x: number; y: number }[], random?: () => number) => { x: number; y: number };
  isOppositeDirection: (current: { x: number; y: number }, incoming: { x: number; y: number }) => boolean;
  createInitialState: (bestScore: number) => {
    snake: { x: number; y: number }[];
    direction: { x: number; y: number };
    nextDirection: { x: number; y: number };
    apple: { x: number; y: number };
    score: number;
    bestScore: number;
    gameOver: boolean;
    isPaused: boolean;
    hasStarted: boolean;
  };
  canMove: (state: { gameOver: boolean; isPaused: boolean; hasStarted: boolean }) => boolean;
};

function loadSnakeApi(): SnakeApi {
  const gamePath = path.join(process.cwd(), "testWorkspace", "game.js");
  const source = fs.readFileSync(gamePath, "utf8");

  const fakeCtx = {
    fillStyle: "",
    fillRect() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    fill() {}
  };

  const canvas = {
    width: 500,
    height: 500,
    getContext() {
      return fakeCtx;
    }
  };

  const stubEl = { textContent: "", dataset: {}, addEventListener() {} };

  const context = {
    window: {},
    document: {
      getElementById(id: string) {
        if (id === "board") return canvas;
        return { ...stubEl };
      },
      querySelectorAll() {
        return [{ addEventListener() {} }, { addEventListener() {} }];
      },
      addEventListener() {}
    },
    localStorage: {
      getItem() {
        return "0";
      },
      setItem() {}
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    Math
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  const api = (context.window as { SnakeGameTestApi?: SnakeApi }).SnakeGameTestApi;
  if (!api) {
    throw new Error("SnakeGameTestApi is not exposed");
  }

  return api;
}

describe("snake game logic api", () => {
  it("creates initial state with preserved best score", () => {
    const api = loadSnakeApi();
    const state = api.createInitialState(7);

    expect(state.bestScore).toBe(7);
    expect(state.score).toBe(0);
    expect(state.hasStarted).toBe(false);
    expect(state.gameOver).toBe(false);
    expect(state.snake[0]).toEqual({ x: 10, y: 10 });
  });

  it("detects opposite directions", () => {
    const api = loadSnakeApi();

    expect(api.isOppositeDirection({ x: 1, y: 0 }, { x: -1, y: 0 })).toBe(true);
    expect(api.isOppositeDirection({ x: 0, y: 1 }, { x: 0, y: -1 })).toBe(true);
    expect(api.isOppositeDirection({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(false);
  });

  it("spawns apple outside snake body", () => {
    const api = loadSnakeApi();

    const snake = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ];

    const sequence = [0, 0, 0.05, 0, 0.9, 0.9];
    let idx = 0;
    const random = () => {
      const value = sequence[idx] ?? 0.9;
      idx += 1;
      return value;
    };

    const apple = api.createApplePosition(20, snake, random);

    expect(snake.some((s) => s.x === apple.x && s.y === apple.y)).toBe(false);
    expect(apple).toEqual({ x: 18, y: 18 });
  });

  it("allows movement only when game is active", () => {
    const api = loadSnakeApi();

    expect(api.canMove({ gameOver: false, isPaused: false, hasStarted: true })).toBe(true);
    expect(api.canMove({ gameOver: true, isPaused: false, hasStarted: true })).toBe(false);
    expect(api.canMove({ gameOver: false, isPaused: true, hasStarted: true })).toBe(false);
    expect(api.canMove({ gameOver: false, isPaused: false, hasStarted: false })).toBe(false);
  });
});
