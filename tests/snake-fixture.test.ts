import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("snake fixture", () => {
  it("keeps browser game fixture assets in testWorkspace", () => {
    const workspaceDir = path.join(process.cwd(), "testWorkspace");
    const html = fs.readFileSync(path.join(workspaceDir, "index.html"), "utf8");
    const gameJs = fs.readFileSync(path.join(workspaceDir, "game.js"), "utf8");
    const css = fs.readFileSync(path.join(workspaceDir, "styles.css"), "utf8");

    expect(html).toContain('<canvas id="board"');
    expect(html).toContain('id="best"');
    expect(html).toContain('class="control-btn"');
    expect(html).toContain('<script src="game.js"></script>');

    expect(gameJs).toContain("SnakeGameTestApi");
    expect(gameJs).toContain("createApplePosition");
    expect(gameJs).toContain("togglePause");

    expect(css).toContain(".controls");
    expect(css).toContain(".control-btn");
  });
});
