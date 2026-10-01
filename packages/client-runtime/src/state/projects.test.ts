import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScratchEnvironmentId } from "./projects.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

describe("resolveScratchEnvironmentId", () => {
  it("uses the current machine when it offers threads without a project", () => {
    expect(resolveScratchEnvironmentId(server, [laptop, server])).toBe(server);
  });

  it("never moves to another machine when the current one does not offer it", () => {
    expect(resolveScratchEnvironmentId(server, [laptop])).toBeNull();
  });

  it("uses the only machine that offers it when there is no current machine", () => {
    expect(resolveScratchEnvironmentId(null, [laptop])).toBe(laptop);
  });

  it("leaves the choice to the user when several machines offer it", () => {
    expect(resolveScratchEnvironmentId(null, [laptop, server])).toBeNull();
  });

  it("has nothing to start on when no machine offers it", () => {
    expect(resolveScratchEnvironmentId(null, [])).toBeNull();
  });
});
